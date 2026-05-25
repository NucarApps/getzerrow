// Core sync pipeline: pull messages for a specific gmail_account, apply filters/AI,
// persist, apply Gmail label/actions. Server-only.
//
// Module layout — this file is the public surface; focused sub-modules
// live under ./sync/:
//   ./sync/account-lock     in-process coalescing lock
//   ./sync/backoff          jitter, retry tables, computeBackoffSeconds
//   ./sync/dlq              isTransientDlqError, replayTransientDlq
//   ./sync/forward-retry    retryForwardAttempts
//   ./sync/history-id       gmailHistoryIdGreater (BigInt comparison)
//
// New imports for callers should go straight to the sub-modules; the
// re-exports below preserve backward compatibility for existing
// `import { x } from "@/lib/sync.server"` call sites.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMessageMetadata, parseMessage, listMessages, listHistory, ensureWatch, GmailApiError } from "./gmail.server";
import {
  computeBackoffSeconds as _computeBackoffSeconds,
} from "./sync/backoff";
import { withAccountLock as _withAccountLock } from "./sync/account-lock";
import { gmailHistoryIdGreater as _gmailHistoryIdGreater } from "./sync/history-id";
import {
  isTransientDlqError as _isTransientDlqError,
  replayTransientDlq as _replayTransientDlq,
} from "./sync/dlq";
import { retryForwardAttempts as _retryForwardAttempts } from "./sync/forward-retry";
import type { Folder, Filter, GmailAccount } from "./sync/types";
import {
  type AccountContext as _AccountContext,
  loadAccountContext as _loadAccountContext,
  invalidateAccountContext as _invalidateAccountContext,
  invalidateAccountContextForUser as _invalidateAccountContextForUser,
} from "./sync/account-context";
import {
  classifyParsedEmail as _classifyParsedEmail,
  type ClassificationResult as _ClassificationResult,
} from "./sync/classify";
import { reconcileLocalInbox as _reconcileLocalInbox } from "./sync/reconcile";
import {
  recordManualMove as _recordManualMove,
  regenerateFolderProfile as _regenerateFolderProfile,
  bumpEmailsSinceLearn as _bumpEmailsSinceLearn,
  learnFromLinkedLabel as _learnFromLinkedLabel,
  loadOlderFromLabel as _loadOlderFromLabel,
} from "./sync/folder-learn";
import {
  processGmailMessage as _processGmailMessage,
  type ProcessTimings as _ProcessTimings,
} from "./sync/process-message";
import {
  enqueueMessageJob as _enqueueMessageJob,
  enqueueMessageJobs as _enqueueMessageJobs,
  runMessageJobs as _runMessageJobs,
  retryMessageJob as _retryMessageJob,
} from "./sync/queue";

// Re-export for backward compatibility with existing imports.
export const withAccountLock = _withAccountLock;
export const computeBackoffSeconds = _computeBackoffSeconds;
export const gmailHistoryIdGreater = _gmailHistoryIdGreater;
export const isTransientDlqError = _isTransientDlqError;
export const replayTransientDlq = _replayTransientDlq;
export const retryForwardAttempts = _retryForwardAttempts;
export type AccountContext = _AccountContext;
export const loadAccountContext = _loadAccountContext;
export const invalidateAccountContext = _invalidateAccountContext;
export const invalidateAccountContextForUser = _invalidateAccountContextForUser;
export const classifyParsedEmail = _classifyParsedEmail;
export type ClassificationResult = _ClassificationResult;
export const reconcileLocalInbox = _reconcileLocalInbox;
export const regenerateFolderProfile = _regenerateFolderProfile;
export const bumpEmailsSinceLearn = _bumpEmailsSinceLearn;
export const learnFromLinkedLabel = _learnFromLinkedLabel;
export const loadOlderFromLabel = _loadOlderFromLabel;
export const processGmailMessage = _processGmailMessage;
export type ProcessTimings = _ProcessTimings;
export const enqueueMessageJob = _enqueueMessageJob;
export const enqueueMessageJobs = _enqueueMessageJobs;
export const runMessageJobs = _runMessageJobs;
export const retryMessageJob = _retryMessageJob;
// recordManualMove is internal to the sync pipeline — used by the
// inline syncSinceHistoryLocked / labelsAdded path that will eventually
// move to ./sync/history.ts.
const recordManualMove = _recordManualMove;

// Shared types (Folder, Filter, OverrideException, GmailAccount, RuleNode)
// moved to ./sync/types.ts and imported above.

async function getAccount(accountId: string): Promise<GmailAccount> {
  const { data, error } = await supabaseAdmin
    .from("gmail_accounts")
    .select("id, user_id, email_address, history_id, watch_expiration")
    .eq("id", accountId)
    .single();
  if (error || !data) throw new Error("Gmail account not found");
  return data as GmailAccount;
}

// (withAccountLock moved to ./sync/account-lock.ts and re-exported above.)
// Filter evaluation (applyFilter, matchByFilters, labelOf, EXCLUDE_OPS) +
// ReDoS-safe regex helpers moved to ./sync/filter-engine.ts and imported
// above.


// (loadFoldersWithExamples + AccountContext + loadAccountContext +
// invalidate* moved to ./sync/account-context.ts and re-exported above.)

// (classifyParsedEmail + ClassificationResult moved to ./sync/classify.ts
// processGmailMessage + ProcessTimings moved to ./sync/process-message.ts
// — both re-exported at the top of this file.)

// (recordManualMove, regenerateFolderProfile, bumpEmailsSinceLearn,
// learnFromLinkedLabel, loadOlderFromLabel moved to ./sync/folder-learn.ts
// and re-exported above.)

export async function backfillRecent(accountId: string, userId: string, maxResults = 100) {
  // Used to bootstrap a fresh account / re-bootstrap after a history-too-old
  // failure. Enqueue at priority=0 (live lane) so the dedicated live worker
  // drains within seconds and we don't block the calling request (often the
  // Pub/Sub webhook). Widened window to 30d to cover longer outages.
  const list = await listMessages(accountId, { maxResults, q: "-in:chats -in:trash -in:spam newer_than:30d" });
  const ids = (list.messages ?? []).map((m) => m.id);
  try {
    await enqueueMessageJobs(accountId, userId, ids, 0);
  } catch (e) {
    console.error("backfillRecent bulk enqueue failed", e);
    return { processed: 0, enqueued: 0, error: (e as Error).message };
  }
  return { processed: ids.length, enqueued: ids.length };
}

export async function backfillWindow(
  accountId: string,
  userId: string,
  opts: { query: string; maxMessages?: number; concurrency?: number },
) {
  const started = Date.now();
  const maxMessages = opts.maxMessages ?? 1000;
  const concurrency = opts.concurrency ?? 4;

  // 1) Page through Gmail collecting IDs, de-duped.
  const ids: string[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  while (ids.length < maxMessages) {
    const remaining = maxMessages - ids.length;
    const list = await listMessages(accountId, {
      q: opts.query,
      maxResults: Math.min(100, remaining),
      pageToken,
    });
    for (const m of list.messages ?? []) {
      if (!seen.has(m.id)) { seen.add(m.id); ids.push(m.id); }
      if (ids.length >= maxMessages) break;
    }
    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }

  // 2) Drop IDs we already have for this account (batched).
  let alreadyHad = 0;
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
      if (have.has(id)) alreadyHad++;
      else todo.push(id);
    }
  }

  // 3) Process with bounded concurrency.
  let processed = 0;
  let failed = 0;
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) return;
      try {
        await processGmailMessage(accountId, todo[i], userId);
        processed++;
      } catch (e) {
        failed++;
        console.error("backfillWindow process failed", todo[i], e);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

  return {
    found: ids.length,
    alreadyHad,
    processed,
    failed,
    durationMs: Date.now() - started,
  };
}

async function bumpHistoryAndWatch(accountId: string, historyId: string) {
  const account = await getAccount(accountId);
  const watch = await ensureWatch(accountId, account.watch_expiration);
  // Gmail historyIds are monotonically increasing per-mailbox. Under
  // overlapping pushes (two replicas, or a push + a manual sync), two
  // concurrent UPDATEs can race; without a guard the LOWER history_id can
  // land last and the next sync re-fetches a window we've already
  // processed. compareGmailHistoryIds rejects any incoming id that's not
  // strictly higher than what's currently in the DB.
  if (watch) {
    await bumpHistoryAndStamp(accountId, watch.historyId, {
      watch_expiration: new Date(parseInt(watch.expiration, 10)).toISOString(),
    });
  } else {
    await bumpHistoryAndStamp(accountId, historyId, {});
  }
}

// (gmailHistoryIdGreater moved to ./sync/history-id.ts and re-exported above.)

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

// ─── Deep backfill jobs (background, paginated across cron ticks) ─────────

type BackfillJob = {
  id: string;
  user_id: string;
  gmail_account_id: string;
  query: string;
  status: string;
  next_page_token: string | null;
  total_found: number;
  total_enqueued: number;
  already_had: number;
};

const BACKFILL_LIST_PAGES_PER_TICK = 20; // ~2000 IDs per tick
const BACKFILL_PAGE_SIZE = 100;

export async function startBackfillJob(
  accountId: string,
  userId: string,
  opts: { months: number },
): Promise<{ job_id: string; reused: boolean }> {
  const months = Math.min(Math.max(opts.months, 1), 120);

  // Reuse any active job for this account.
  const { data: existing } = await supabaseAdmin
    .from("backfill_jobs")
    .select("id")
    .eq("gmail_account_id", accountId)
    .in("status", ["listing", "processing"])
    .limit(1)
    .maybeSingle();
  if (existing) return { job_id: existing.id, reused: true };

  // Use a date anchor so the query is stable across ticks (newer_than:Nd
  // would shift as time passes). Gmail "after:" accepts YYYY/MM/DD.
  const since = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000);
  const y = since.getUTCFullYear();
  const m = String(since.getUTCMonth() + 1).padStart(2, "0");
  const d = String(since.getUTCDate()).padStart(2, "0");
  const query = `after:${y}/${m}/${d} -in:chats -in:trash -in:spam`;

  const { data: row, error } = await supabaseAdmin
    .from("backfill_jobs")
    .insert({
      user_id: userId,
      gmail_account_id: accountId,
      query,
      months,
      status: "listing",
    })
    .select("id")
    .single();
  if (error || !row) throw new Error(`Failed to start backfill: ${error?.message}`);
  return { job_id: row.id, reused: false };
}

export async function cancelBackfillJob(jobId: string, userId: string) {
  await supabaseAdmin
    .from("backfill_jobs")
    .update({ status: "canceled", finished_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("user_id", userId)
    .in("status", ["listing", "processing"]);
  return { ok: true };
}

export async function tickBackfillJobs(maxJobs = 2) {
  const { data: jobs } = await supabaseAdmin
    .from("backfill_jobs")
    .select("id, user_id, gmail_account_id, query, status, next_page_token, total_found, total_enqueued, already_had")
    .in("status", ["listing", "processing"])
    .order("updated_at", { ascending: true })
    .limit(maxJobs);
  const results: Array<{ job_id: string; phase: string; added?: number; error?: string }> = [];
  for (const job of (jobs ?? []) as BackfillJob[]) {
    try {
      const r = await tickBackfillJob(job);
      results.push({ job_id: job.id, ...r });
    } catch (e: any) {
      console.error("tickBackfillJob failed", job.id, e);
      await supabaseAdmin
        .from("backfill_jobs")
        .update({ last_error: String(e?.message ?? e).slice(0, 500) })
        .eq("id", job.id);
      results.push({ job_id: job.id, phase: "error", error: String(e?.message ?? e) });
    }
  }
  return { processed: results.length, results };
}

async function tickBackfillJob(job: BackfillJob): Promise<{ phase: string; added?: number }> {
  if (job.status === "listing") {
    let pageToken: string | undefined = job.next_page_token ?? undefined;
    let foundDelta = 0;
    let enqueuedDelta = 0;
    let alreadyDelta = 0;
    let pages = 0;

    while (pages < BACKFILL_LIST_PAGES_PER_TICK) {
      const list = await listMessages(job.gmail_account_id, {
        q: job.query,
        maxResults: BACKFILL_PAGE_SIZE,
        pageToken,
      });
      const ids = (list.messages ?? []).map((m) => m.id);
      foundDelta += ids.length;
      pages++;

      if (ids.length > 0) {
        // Dedupe vs already-stored emails for this account.
        const { data: existing } = await supabaseAdmin
          .from("emails")
          .select("gmail_message_id")
          .eq("gmail_account_id", job.gmail_account_id)
          .in("gmail_message_id", ids);
        const have = new Set((existing ?? []).map((r) => r.gmail_message_id));
        const todo = ids.filter((id) => !have.has(id));
        alreadyDelta += ids.length - todo.length;

        // Single batched upsert per page (vs N×roundtrip).
        try {
          await enqueueMessageJobs(job.gmail_account_id, job.user_id, todo, 10);
          enqueuedDelta += todo.length;
        } catch (e) {
          console.error("backfill page bulk enqueue failed", e);
        }
      }

      pageToken = list.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    const done = !pageToken;
    await supabaseAdmin
      .from("backfill_jobs")
      .update({
        next_page_token: pageToken ?? null,
        total_found: job.total_found + foundDelta,
        total_enqueued: job.total_enqueued + enqueuedDelta,
        already_had: job.already_had + alreadyDelta,
        status: done ? "processing" : "listing",
      })
      .eq("id", job.id);

    return { phase: done ? "listed" : "listing", added: enqueuedDelta };
  }

  // processing: drain wait — check remaining message_jobs for this account.
  const { count } = await supabaseAdmin
    .from("message_jobs")
    .select("id", { count: "exact", head: true })
    .eq("gmail_account_id", job.gmail_account_id)
    .neq("status", "dlq");

  if ((count ?? 0) === 0) {
    await supabaseAdmin
      .from("backfill_jobs")
      .update({ status: "done", finished_at: new Date().toISOString() })
      .eq("id", job.id);
    return { phase: "done" };
  }

  // Touch updated_at so the picker rotates fairly.
  await supabaseAdmin
    .from("backfill_jobs")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", job.id);
  return { phase: "draining" };
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


// (Queue — enqueueMessageJob, enqueueMessageJobs, runMessageJobs,
// retryMessageJob — moved to ./sync/queue.ts and re-exported above.)

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

    // Batch deletes / label changes so a history page with N events is N
    // events worth of work, not N×roundtrips.
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
          // Metadata fetch — 10x smaller than full body — is enough to record
          // the manual-move example (from_addr/subject/snippet).
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

    // Bulk-enqueue all newly-added messages in one upsert (vs the previous
    // N×sequential upserts). The published_at_ms is threaded through so any
    // worker can populate emails.published_at_ms when it drains the job.
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

    // Apply label ops sequentially per message. We SKIP ops whose message
    // is ALSO in seenAdded — those rows don't exist yet (still queued via
    // message_jobs) so the UPDATE would silently no-op and the label change
    // would be lost. processGmailMessage will set raw_labels correctly from
    // parseMessage when the queued job runs.
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
    } catch { /* best-effort */ }
    return { synced: seenAdded.size };
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    // Only treat 404 (history_id genuinely expired in Gmail) as "rebootstrap".
    // Transient errors (429, 5xx, network) get returned to the caller so the
    // next push/poll retries cheaply, instead of triggering an expensive
    // full-mailbox bootstrap.
    if (e instanceof GmailApiError && e.status === 404) {
      console.error("history_id expired, queueing rebootstrap", accountId);
      await supabaseAdmin.from("gmail_accounts").update({ history_id: null }).eq("id", accountId);
      return { error: msg, rebootstrapped: true };
    }
    console.error("history sync failed (transient)", accountId, msg);
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
        console.error("bootstrap bulk enqueue failed", e);
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
    await supabaseAdmin.from("gmail_accounts")
      .update({ last_history_sync_at: new Date().toISOString() })
      .eq("id", accountId);
  } catch { /* best-effort */ }
  return { bootstrapped: true };
}

// (reconcileLocalInbox moved to ./sync/reconcile.ts and re-exported above.)


// Forward-retry + DLQ-replay logic lives in:
//   ./sync/forward-retry.ts → retryForwardAttempts
//   ./sync/dlq.ts          → isTransientDlqError, replayTransientDlq
// Both are re-exported at the top of this file for backward compat.
