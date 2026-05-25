// History-diff sync — the hot path that runs on every Pub/Sub push and
// every poll cron tick.
//
// FLOW
//   syncSinceHistory(accountId, { publishedAtMs })
//     -> withAccountLock per-process coalescing
//     -> syncSinceHistoryLocked
//        -> if account has no history_id: bootstrapAccount
//        -> else: listHistory(start=stored history_id)
//           -> bulk-enqueue messagesAdded
//           -> apply labelsAdded / labelsRemoved
//           -> batch-delete messagesDeleted
//           -> bumpHistoryAndWatch (atomic monotonic guard)
//           -> stamp last_history_sync_at (+ last_push_at if from push)
//
//   bootstrapAccount handles the cold-start / history-expired case:
//   anchors to the newest local email's received_at and pages Gmail
//   from that point, capped at 2000 messages (anything older falls
//   to the deep-backfill job).
//
// CROSS-REPLICA SAFETY
//   bumpHistoryAndWatch goes through the bump_history_id_if_greater
//   SQL function which atomically guards monotonicity. If two replicas
//   race on overlapping pushes the higher historyId always wins. The
//   JS-side fallback (when the RPC fails) uses gmailHistoryIdGreater
//   for the same check, less reliably.
//
// LABEL-OP ORDERING BUG
//   When a history page contains both messagesAdded[m] AND labelsAdded
//   for that same message, the labelsAdded handler used to UPDATE a
//   row that didn't exist yet (still queued in message_jobs). The
//   UPDATE silently no-opped and the label state was lost. We now skip
//   labelOps whose messageId is in seenAdded — processGmailMessage
//   sets raw_labels correctly from parseMessage when the queued job
//   runs, so the label state isn't actually lost.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  ensureWatch,
  getMessageMetadata,
  listHistory,
  listMessages,
  parseMessage,
  GmailApiError,
} from "../gmail.server";
import { withAccountLock } from "./account-lock";
import { gmailHistoryIdGreater } from "./history-id";
import { enqueueMessageJobs } from "./queue";
import { recordManualMove } from "./folder-learn";
import { backfillRecent } from "./backfill";
import type { Folder, GmailAccount } from "./types";

async function getAccount(accountId: string): Promise<GmailAccount> {
  const { data, error } = await supabaseAdmin
    .from("gmail_accounts")
    .select("id, user_id, email_address, history_id, watch_expiration")
    .eq("id", accountId)
    .single();
  if (error || !data) throw new Error("Gmail account not found");
  return data as GmailAccount;
}

export async function syncSinceHistory(
  accountId: string,
  opts: { publishedAtMs?: number | null } = {},
) {
  // Coalesce overlapping calls per account. A Pub/Sub redelivery + the
  // polling cron + a manual sync click can otherwise all run at once,
  // race on history_id, and either miss events or burn duplicate work.
  return withAccountLock(accountId, () => syncSinceHistoryLocked(accountId, opts));
}

async function syncSinceHistoryLocked(
  accountId: string,
  opts: { publishedAtMs?: number | null } = {},
) {
  const account = await getAccount(accountId);
  if (!account.history_id) {
    // Bootstrap is best-effort: on failure (Gmail 429, quota, network
    // blip) we surface the error and leave history_id null so the next
    // push/poll retries. Without this catch the exception escapes
    // withAccountLock and the caller logs but doesn't otherwise
    // rate-limit the next attempt.
    try {
      const r = await bootstrapAccount(accountId, account.user_id);
      // Push-driven bootstrap also stamps last_push_at — otherwise the
      // poll cron will keep thinking this account is push-silent.
      if (opts.publishedAtMs != null) {
        try {
          await supabaseAdmin.from("gmail_accounts")
            .update({ last_push_at: new Date().toISOString() })
            .eq("id", accountId);
        } catch { /* best-effort */ }
      }
      return r;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      console.error("bootstrap failed", accountId, msg);
      return { bootstrapped: false, error: msg };
    }
  }
  try {
    const hist = await listHistory(accountId, account.history_id);
    const seenAdded = new Set<string>();
    const { data: folders } = await supabaseAdmin.from("folders").select("*").eq("gmail_account_id", accountId);
    const folderList = (folders ?? []) as Folder[];
    const labelToFolder = new Map<string, Folder>();
    for (const f of folderList) if (f.gmail_label_id) labelToFolder.set(f.gmail_label_id, f);

    // Batch deletes / label changes so a history page with N events is
    // N events worth of work, not N×roundtrips.
    const toDelete = new Set<string>();
    type LabelOp = { messageId: string; currentLabels: string[] | undefined; added: string[]; removed: string[] };
    const labelOps: LabelOp[] = [];

    for (const h of hist.history || []) {
      const added = h.messagesAdded?.map((x) => x.message) ?? h.messages ?? [];
      for (const m of added) {
        if (seenAdded.has(m.id)) continue;
        seenAdded.add(m.id);
      }
      for (const ev of h.labelsAdded ?? []) {
        labelOps.push({ messageId: ev.message.id, currentLabels: ev.message.labelIds, added: ev.labelIds, removed: [] });
        const matched = ev.labelIds.map((l) => labelToFolder.get(l)).filter(Boolean) as Folder[];
        if (matched.length === 0) continue;
        try {
          // Metadata fetch — 10x smaller than full body — is enough to
          // record the manual-move example (from_addr/subject/snippet).
          const meta = await getMessageMetadata(accountId, ev.message.id);
          const p = parseMessage(meta);
          for (const folder of matched) {
            await recordManualMove(folder, accountId, account.user_id, {
              gmail_message_id: p.gmail_message_id,
              from_addr: p.from_addr,
              subject: p.subject,
              snippet: p.snippet,
            });
          }
        } catch (e) { console.error("labelAdded handler failed", e); }
      }
      for (const ev of h.labelsRemoved ?? []) {
        labelOps.push({ messageId: ev.message.id, currentLabels: ev.message.labelIds, added: [], removed: ev.labelIds });
      }
      for (const ev of h.messagesDeleted ?? []) {
        toDelete.add(ev.message.id);
      }
    }

    // Bulk-enqueue all newly-added messages in one upsert (vs the
    // previous N×sequential upserts). publishedAtMs threads through so
    // any worker can populate emails.published_at_ms when it drains
    // the job.
    if (seenAdded.size > 0) {
      try {
        await enqueueMessageJobs(
          accountId,
          account.user_id,
          Array.from(seenAdded),
          0,
          { publishedAtMs: opts.publishedAtMs ?? null },
        );
      } catch (e) { console.error("bulk enqueue failed", e); }
    }

    // Apply label ops sequentially per message. SKIP ops whose message
    // is ALSO in seenAdded — those rows don't exist yet (still queued
    // via message_jobs) so the UPDATE would silently no-op and the
    // label change would be lost. processGmailMessage sets raw_labels
    // correctly from parseMessage when the queued job runs.
    for (const op of labelOps) {
      if (seenAdded.has(op.messageId)) continue;
      try { await applyLabelChange(accountId, op.messageId, op.currentLabels, op.added, op.removed); }
      catch (e) { console.error("applyLabelChange failed", e); }
    }

    if (toDelete.size > 0) {
      try {
        await supabaseAdmin.from("emails").delete()
          .eq("gmail_account_id", accountId)
          .in("gmail_message_id", Array.from(toDelete));
      } catch (e) { console.error("messagesDeleted batch handler failed", e); }
    }

    if (hist.historyId) await bumpHistoryAndWatch(accountId, hist.historyId);
    // Stamp two timestamps:
    //   last_history_sync_at — ticks on every successful sync (push OR
    //     poll). Used for "we touched this account recently" UX.
    //   last_push_at — ticks ONLY on webhook-initiated syncs
    //     (opts.publishedAtMs is non-null). The poll cron uses this to
    //     detect "no push in 2h → watch is probably broken". Stamping
    //     it on poll runs would defeat its purpose.
    const stamp: { last_history_sync_at: string; last_push_at?: string } = {
      last_history_sync_at: new Date().toISOString(),
    };
    if (opts.publishedAtMs != null) stamp.last_push_at = new Date().toISOString();
    try {
      await supabaseAdmin.from("gmail_accounts").update(stamp).eq("id", accountId);
    } catch { /* best-effort */ }
    return { synced: seenAdded.size };
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    // Only treat 404 (history_id genuinely expired in Gmail) as
    // "rebootstrap". Transient errors (429, 5xx, network) get returned
    // to the caller so the next push/poll retries cheaply, instead of
    // triggering an expensive full-mailbox bootstrap.
    if (e instanceof GmailApiError && e.status === 404) {
      console.error("history_id expired, queueing rebootstrap", accountId);
      await supabaseAdmin.from("gmail_accounts").update({ history_id: null }).eq("id", accountId);
      return { error: msg, rebootstrapped: true };
    }
    console.error("history sync failed (transient)", accountId, msg);
    return { error: msg };
  }
}

/** Bootstrap a Gmail account whose history_id is null/expired. The
 * naive path would pull the last 20 messages, which loses every
 * message between our newest local row and Gmail's current head. We
 * anchor the bootstrap to the newest local email so the gap (whether
 * 5 minutes or 5 days) is filled in. Capped at 2000 messages —
 * anything older falls to the deep-backfill job. */
async function bootstrapAccount(accountId: string, userId: string) {
  const { data: newest } = await supabaseAdmin
    .from("emails")
    .select("received_at")
    .eq("gmail_account_id", accountId)
    .not("received_at", "is", null)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (newest?.received_at) {
    const anchorSecs = Math.floor(new Date(newest.received_at).getTime() / 1000);
    const MAX_BOOTSTRAP = 2000;
    let pageToken: string | undefined;
    const collected: string[] = [];
    while (collected.length < MAX_BOOTSTRAP) {
      const list = await listMessages(accountId, {
        q: `after:${anchorSecs} -in:chats -in:trash -in:spam`,
        maxResults: 100,
        pageToken,
      });
      for (const m of list.messages ?? []) collected.push(m.id);
      pageToken = list.nextPageToken;
      if (!pageToken) break;
    }

    if (collected.length > 0) {
      const seen = new Set<string>();
      const ids = collected.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
      // Skip ids we already have locally before enqueueing — saves the
      // worker from doing 2000 noop fetches against Gmail.
      const todo: string[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500);
        const { data: existing } = await supabaseAdmin
          .from("emails")
          .select("gmail_message_id")
          .eq("gmail_account_id", accountId)
          .in("gmail_message_id", slice);
        const have = new Set((existing ?? []).map((r) => r.gmail_message_id));
        for (const id of slice) {
          if (!have.has(id)) todo.push(id);
        }
      }
      try {
        await enqueueMessageJobs(accountId, userId, todo, 0);
      } catch (e) {
        console.error("bootstrap bulk enqueue failed", e);
      }
    }
  } else {
    // No local rows at all — fall back to the 30-day primer.
    await backfillRecent(accountId, userId, 100);
  }

  // Just need historyId; metadata fetch is 10x lighter than full body.
  const recent = await listMessages(accountId, { maxResults: 1 });
  if (recent.messages?.[0]) {
    const m = await getMessageMetadata(accountId, recent.messages[0].id);
    if (m.historyId) await bumpHistoryAndWatch(accountId, m.historyId);
  }
  // Stamp last_history_sync_at so the poll cron's silence-detection
  // treats this freshly-bootstrapped account as healthy.
  try {
    await supabaseAdmin.from("gmail_accounts")
      .update({ last_history_sync_at: new Date().toISOString() })
      .eq("id", accountId);
  } catch { /* best-effort */ }
  return { bootstrapped: true };
}

async function applyLabelChange(
  accountId: string,
  messageId: string,
  currentLabels: string[] | undefined,
  added: string[],
  removed: string[],
) {
  const patch: { raw_labels?: string[]; is_archived?: boolean; is_read?: boolean } = {};
  if (currentLabels) patch.raw_labels = currentLabels;
  if (removed.includes("INBOX")) patch.is_archived = true;
  if (added.includes("INBOX")) patch.is_archived = false;
  if (removed.includes("UNREAD")) patch.is_read = true;
  if (added.includes("UNREAD")) patch.is_read = false;
  if (added.includes("TRASH")) {
    await supabaseAdmin.from("emails").delete()
      .eq("gmail_account_id", accountId)
      .eq("gmail_message_id", messageId);
    return;
  }
  if (Object.keys(patch).length === 0) return;
  await supabaseAdmin.from("emails").update(patch)
    .eq("gmail_account_id", accountId)
    .eq("gmail_message_id", messageId);
}

async function bumpHistoryAndWatch(accountId: string, historyId: string) {
  const account = await getAccount(accountId);
  const watch = await ensureWatch(accountId, account.watch_expiration);
  // Gmail historyIds are monotonically increasing per-mailbox. Under
  // overlapping pushes (two replicas, or a push + a manual sync), two
  // concurrent UPDATEs can race; without a guard the LOWER history_id
  // can land last and the next sync re-fetches a window we've already
  // processed.
  if (watch) {
    await bumpHistoryAndStamp(accountId, watch.historyId, {
      watch_expiration: new Date(parseInt(watch.expiration, 10)).toISOString(),
    });
  } else {
    await bumpHistoryAndStamp(accountId, historyId, {});
  }
}

/** Bump history_id with a monotonic guard via an atomic SQL RPC. If a
 * concurrent writer already stored a higher history_id we leave the
 * row alone — losing a few cycles of work is better than re-processing
 * a window we've already covered. */
async function bumpHistoryAndStamp(
  accountId: string,
  incomingHistoryId: string,
  extra: { watch_expiration?: string },
) {
  type BumpRpc = {
    rpc: (
      fn: "bump_history_id_if_greater",
      args: { p_account_id: string; p_new_history_id: string; p_watch_expiration: string | null },
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const { error } = await (supabaseAdmin as unknown as BumpRpc).rpc("bump_history_id_if_greater", {
    p_account_id: accountId,
    p_new_history_id: incomingHistoryId,
    p_watch_expiration: extra.watch_expiration ?? null,
  });
  if (error) {
    // RPC isn't deployed yet, or some other DB error. Fall back to the
    // JS-only check — strictly worse on overlapping replicas but still
    // better than blind UPDATE.
    console.error("bump_history_id_if_greater RPC failed, falling back", error.message);
    const { data: current } = await supabaseAdmin
      .from("gmail_accounts")
      .select("history_id")
      .eq("id", accountId)
      .maybeSingle();
    if (!gmailHistoryIdGreater(incomingHistoryId, current?.history_id ?? null)) {
      if (extra.watch_expiration) {
        await supabaseAdmin
          .from("gmail_accounts")
          .update({ watch_expiration: extra.watch_expiration, last_poll_at: new Date().toISOString() })
          .eq("id", accountId);
      }
      return;
    }
    await supabaseAdmin
      .from("gmail_accounts")
      .update({
        history_id: incomingHistoryId,
        last_poll_at: new Date().toISOString(),
        ...(extra.watch_expiration ? { watch_expiration: extra.watch_expiration } : {}),
      })
      .eq("id", accountId);
  }
}
