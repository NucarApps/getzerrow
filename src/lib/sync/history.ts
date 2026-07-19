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
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  getMessageMetadata,
  listMessages,
  listHistory,
  ensureWatch,
  GmailApiError,
} from "../gmail.server";
import { logError } from "../log.server";
import { computeLabelPatch } from "./label-merge";
import { collectAddedMessages } from "./history-events";
import { withAccountLock } from "./account-lock";
import { gmailHistoryIdGreater } from "./history-id";
import { recordManualMove } from "./folder-learn";
import { enqueueMessageJobs } from "./enqueue";
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
  // polling cron + a manual sync click can otherwise all run at once, race
  // on history_id, and either miss events or burn duplicate work.
  return withAccountLock(accountId, () => syncSinceHistoryLocked(accountId, opts));
}

async function syncSinceHistoryLocked(
  accountId: string,
  opts: { publishedAtMs?: number | null } = {},
) {
  const account = await getAccount(accountId);
  if (!account.history_id) {
    // Bootstrap is best-effort: on failure (Gmail 429, quota, network blip)
    // we surface the error and leave history_id null so the NEXT push/poll
    // retries. Without this catch the exception escapes withAccountLock and
    // the caller logs but doesn't otherwise rate-limit the next attempt.
    try {
      const r = await bootstrapAccount(accountId, account.user_id);
      // Push-driven bootstrap should also stamp last_push_at — otherwise the
      // poll cron will keep thinking this account is push-silent.
      if (opts.publishedAtMs != null) {
        try {
          await supabaseAdmin
            .from("gmail_accounts")
            .update({ last_push_at: new Date().toISOString() })
            .eq("id", accountId);
        } catch {
          /* best-effort */
        }
      }
      return r;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      logError("sync.bootstrap_failed", { account_id: accountId, user_id: account.user_id }, e);
      return { bootstrapped: false, error: msg };
    }
  }
  try {
    const seenAdded = new Set<string>();
    const { data: folders } = await supabaseAdmin
      .from("folders")
      .select("*")
      .eq("gmail_account_id", accountId);
    const folderList = (folders ?? []) as Folder[];
    const labelToFolder = new Map<string, Folder>();
    for (const f of folderList) if (f.gmail_label_id) labelToFolder.set(f.gmail_label_id, f);

    // Batch deletes / label changes so a history page with N events is N
    // events worth of work, not N×roundtrips.
    const toDelete = new Set<string>();
    type LabelOp = {
      messageId: string;
      currentLabels: string[] | undefined;
      added: string[];
      removed: string[];
    };
    const labelOps: LabelOp[] = [];

    // Walk every history page before advancing the cursor. Gmail caps each
    // page at ~100 history records; busy mailboxes can easily exceed that
    // in a single push, and skipping pages means missed archive/label
    // events. Cap iterations so a runaway pageToken can't loop forever.
    let pageToken: string | undefined;
    let lastHistoryId: string | undefined;
    const MAX_HISTORY_PAGES = 25;
    let pages = 0;
    while (pages < MAX_HISTORY_PAGES) {
      const hist = await listHistory(accountId, account.history_id, pageToken);
      pages++;
      if (hist.historyId) lastHistoryId = hist.historyId;
      for (const h of hist.history || []) {
        // Only messagesAdded is authoritative "new mail". Label-only and
        // delete-only records also carry a generic `messages` list; the
        // old fallback dumped those ids into seenAdded, which made the
        // labelOps skip below swallow archive/un-archive signals from
        // Gmail (see ./history-events.ts).
        const added = collectAddedMessages(h);
        for (const m of added) {
          if (seenAdded.has(m.id)) continue;
          seenAdded.add(m.id);
        }
        for (const ev of h.labelsAdded ?? []) {
          labelOps.push({
            messageId: ev.message.id,
            currentLabels: ev.message.labelIds,
            added: ev.labelIds,
            removed: [],
          });
          const matched = ev.labelIds.map((l) => labelToFolder.get(l)).filter(Boolean) as Folder[];
          if (matched.length === 0) continue;
          // IMPORTANT: do NOT call getMessageMetadata here. A noisy mailbox
          // produces hundreds of labelsAdded events per push; one Gmail
          // round-trip per event burns the 250-req/min/user quota in
          // seconds and stalls all subsequent syncs (history_id never
          // advances → next push replays the same backlog → spiral).
          // Source from/subject/snippet from the local emails row if it
          // exists; otherwise skip — process-message will seed the folder
          // example correctly when the message is later ingested through
          // the normal pipeline (it's already in seenAdded if new).
          try {
            const { data: localRow } = await supabaseAdmin
              .from("emails")
              .select("id")
              .eq("gmail_account_id", accountId)
              .eq("gmail_message_id", ev.message.id)
              .maybeSingle();
            if (!localRow) continue;
            for (const folder of matched) {
              await recordManualMove(folder, accountId, account.user_id, {
                gmail_message_id: ev.message.id,
                from_addr: "",
                subject: "",
                snippet: "",
              });
            }
          } catch (e) {
            logError(
              "sync.label_added_handler_failed",
              { account_id: accountId, gmail_message_id: ev.message.id, added_labels: ev.labelIds },
              e,
            );
          }
        }
        for (const ev of h.labelsRemoved ?? []) {
          labelOps.push({
            messageId: ev.message.id,
            currentLabels: ev.message.labelIds,
            added: [],
            removed: ev.labelIds,
          });
        }
        for (const ev of h.messagesDeleted ?? []) {
          toDelete.add(ev.message.id);
        }
      }
      // Advance the stored history cursor AFTER each successful page, not
      // only after the entire walk. If a later page 403s (quota) or 5xxs,
      // the next push restarts from the page we already drained instead
      // of replaying the whole backlog from the original startHistoryId.
      // bump_history_id_if_greater is monotonic, so this is safe.
      if (hist.historyId) {
        try {
          await bumpHistoryAndWatch(accountId, hist.historyId);
        } catch (e) {
          logError(
            "sync.bump_history_page_failed",
            { account_id: accountId, page_history_id: hist.historyId },
            e,
          );
        }
      }
      pageToken = hist.nextPageToken;
      if (!pageToken) break;
    }
    if (pages >= MAX_HISTORY_PAGES && pageToken) {
      logError(
        "sync.history_pages_capped",
        { account_id: accountId, pages, max: MAX_HISTORY_PAGES },
        new Error("history pagination cap hit"),
      );
    }

    // Bulk-enqueue all newly-added messages in one upsert (vs the previous
    // N×sequential upserts). The published_at_ms is threaded through so any
    // worker can populate emails.published_at_ms when it drains the job.
    if (seenAdded.size > 0) {
      try {
        await enqueueMessageJobs(accountId, account.user_id, Array.from(seenAdded), 0, {
          publishedAtMs: opts.publishedAtMs ?? null,
        });
      } catch (e) {
        logError(
          "sync.bulk_enqueue_failed",
          { account_id: accountId, user_id: account.user_id, count: seenAdded.size },
          e,
        );
      }
    }

    // Apply label ops sequentially per message. We SKIP ops whose message
    // is ALSO in seenAdded — those rows don't exist yet (still queued via
    // message_jobs) so the UPDATE would silently no-op and the label change
    // would be lost. processGmailMessage will set raw_labels correctly from
    // parseMessage when the queued job runs.
    for (const op of labelOps) {
      if (seenAdded.has(op.messageId)) continue;
      try {
        await applyLabelChange(
          accountId,
          op.messageId,
          op.currentLabels,
          op.added,
          op.removed,
          labelToFolder,
          account.user_id,
        );
      } catch (e) {
        logError(
          "sync.apply_label_change_failed",
          {
            account_id: accountId,
            gmail_message_id: op.messageId,
            added: op.added,
            removed: op.removed,
          },
          e,
        );
      }
    }

    if (toDelete.size > 0) {
      try {
        await supabaseAdmin
          .from("emails")
          .delete()
          .eq("gmail_account_id", accountId)
          .in("gmail_message_id", Array.from(toDelete));
      } catch (e) {
        logError(
          "sync.messages_deleted_batch_failed",
          { account_id: accountId, count: toDelete.size },
          e,
        );
      }
    }

    // Only advance the stored history cursor after every page has been
    // processed — otherwise a later page's archive event would be skipped
    // on the next sync.
    if (lastHistoryId) await bumpHistoryAndWatch(accountId, lastHistoryId);
    // Stamp two timestamps:
    //   last_history_sync_at — ticks on every successful sync (push OR poll).
    //     Used for "we touched this account recently" UX.
    //   last_push_at — ticks ONLY on webhook-initiated syncs (opts.publishedAtMs
    //     is non-null). The poll cron uses this to detect "no push in 2h →
    //     watch is probably broken". Stamping it on poll runs would defeat
    //     its purpose.
    const stamp: { last_history_sync_at: string; last_push_at?: string } = {
      last_history_sync_at: new Date().toISOString(),
    };
    if (opts.publishedAtMs != null) stamp.last_push_at = new Date().toISOString();
    try {
      await supabaseAdmin.from("gmail_accounts").update(stamp).eq("id", accountId);
    } catch {
      /* best-effort */
    }
    return { synced: seenAdded.size };
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    // Only treat 404 (history_id genuinely expired in Gmail) as "rebootstrap".
    // Transient errors (429, 5xx, network) get returned to the caller so the
    // next push/poll retries cheaply, instead of triggering an expensive
    // full-mailbox bootstrap.
    if (e instanceof GmailApiError && e.status === 404) {
      logError("sync.history_id_expired", { account_id: accountId, action: "rebootstrap" }, e);
      await supabaseAdmin.from("gmail_accounts").update({ history_id: null }).eq("id", accountId);
      return { error: msg, rebootstrapped: true };
    }
    logError("sync.history_sync_transient_failed", { account_id: accountId }, e);
    return { error: msg };
  }
}

/**
 * Bootstrap a Gmail account whose history_id is null/expired. The naive path
 * pulls the last 20 messages, which loses every message between our newest
 * local row and Gmail's current head. Here we anchor the bootstrap to the
 * newest local email so the gap (whether 5 minutes or 5 days) is filled in.
 */
async function bootstrapAccount(accountId: string, userId: string) {
  // Find the newest local email for this account; anchor the catch-up to it.
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
    // Page through Gmail since the anchor, enqueueing every id we don't have yet.
    // We cap the bootstrap at 2000 messages — anything older falls to the
    // deep-backfill job rather than blocking this critical-path call.
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
        logError(
          "sync.bootstrap_enqueue_failed",
          { account_id: accountId, user_id: userId, count: todo.length },
          e,
        );
      }
    }
  } else {
    // No local rows at all — fall back to the original 30-day primer.
    await backfillRecent(accountId, userId, 100);
  }

  // Just need historyId; metadata fetch is 10x lighter than full body.
  const recent = await listMessages(accountId, { maxResults: 1 });
  if (recent.messages?.[0]) {
    const m = await getMessageMetadata(accountId, recent.messages[0].id);
    if (m.historyId) await bumpHistoryAndWatch(accountId, m.historyId);
  }
  // Stamp last_history_sync_at so the poll cron's silence-detection treats this
  // freshly-bootstrapped account as healthy.
  try {
    await supabaseAdmin
      .from("gmail_accounts")
      .update({ last_history_sync_at: new Date().toISOString() })
      .eq("id", accountId);
  } catch {
    /* best-effort */
  }
  return { bootstrapped: true };
}

async function applyLabelChange(
  accountId: string,
  messageId: string,
  currentLabels: string[] | undefined,
  added: string[],
  removed: string[],
  labelToFolder?: Map<string, { id: string; gmail_label_id: string | null }>,
  userId?: string,
) {
  // Trashed OR marked-as-spam in Gmail → drop the local row. Both leave
  // the message invisible in Gmail's inbox/all-mail, so keeping it in
  // Zerrow just shows stale mail the user already dealt with.
  if (added.includes("TRASH") || added.includes("SPAM")) {
    await supabaseAdmin
      .from("emails")
      .delete()
      .eq("gmail_account_id", accountId)
      .eq("gmail_message_id", messageId);
    return;
  }

  // Restored from trash/spam in Gmail → the local row was deleted when it
  // was trashed, so a plain UPDATE would no-op. Re-ingest through the
  // normal pipeline instead.
  if (userId && (removed.includes("TRASH") || removed.includes("SPAM"))) {
    const { data: existingRow } = await supabaseAdmin
      .from("emails")
      .select("id")
      .eq("gmail_account_id", accountId)
      .eq("gmail_message_id", messageId)
      .maybeSingle();
    if (!existingRow) {
      await enqueueMessageJobs(accountId, userId, [messageId], 0);
      return;
    }
  }
  const patch: Record<string, unknown> = { ...computeLabelPatch(currentLabels, added, removed) };

  // Mirror folder_id with Gmail label state. When the user removes a folder's
  // Gmail label, the email should drop out of that folder in Zerrow; when
  // they add one, it should jump into the matching folder.
  if (labelToFolder && labelToFolder.size > 0) {
    const addedFolder = added.map((l) => labelToFolder.get(l)).find(Boolean);
    const removedFolderIds = new Set(
      removed.map((l) => labelToFolder.get(l)?.id).filter(Boolean) as string[],
    );
    if (addedFolder) {
      patch.folder_id = addedFolder.id;
      patch.classified_by = "gmail_labeled";
    } else if (removedFolderIds.size > 0) {
      // Only clear folder_id if it matches a folder whose label was just removed.
      const { data: cur } = await supabaseAdmin
        .from("emails")
        .select("folder_id")
        .eq("gmail_account_id", accountId)
        .eq("gmail_message_id", messageId)
        .maybeSingle();
      if (cur?.folder_id && removedFolderIds.has(cur.folder_id)) {
        patch.folder_id = null;
        patch.classified_by = "gmail_unlabeled";
      }
    }
  }

  if (Object.keys(patch).length === 0) return;
  await supabaseAdmin
    .from("emails")
    .update(patch as never)
    .eq("gmail_account_id", accountId)
    .eq("gmail_message_id", messageId);
}

async function bumpHistoryAndWatch(accountId: string, historyId: string) {
  const account = await getAccount(accountId);
  const watch = await ensureWatch(accountId, account.watch_expiration);
  // Gmail historyIds are monotonically increasing per-mailbox. Under
  // overlapping pushes (two replicas, or a push + a manual sync), two
  // concurrent UPDATEs can race; without a guard the LOWER history_id can
  // land last and the next sync re-fetches a window we've already
  // processed. bump_history_id_if_greater rejects any incoming id that's
  // not strictly higher than what's currently in the DB.
  if (watch) {
    await bumpHistoryAndStamp(accountId, watch.historyId, {
      watch_expiration: new Date(parseInt(watch.expiration, 10)).toISOString(),
    });
  } else {
    await bumpHistoryAndStamp(accountId, historyId, {});
  }
}

/** Bump history_id with a monotonic guard via an atomic SQL RPC. If a
 * concurrent writer already stored a higher history_id we leave the row
 * alone — losing a few cycles of work is better than re-processing a
 * window we've already covered. */
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
    logError(
      "sync.bump_history_rpc_failed",
      { account_id: accountId, incoming_history_id: incomingHistoryId },
      error,
    );
    const { data: current } = await supabaseAdmin
      .from("gmail_accounts")
      .select("history_id")
      .eq("id", accountId)
      .maybeSingle();
    if (!gmailHistoryIdGreater(incomingHistoryId, current?.history_id ?? null)) {
      if (extra.watch_expiration) {
        await supabaseAdmin
          .from("gmail_accounts")
          .update({
            watch_expiration: extra.watch_expiration,
            last_poll_at: new Date().toISOString(),
          })
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
