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
import {
  getMessageMetadata,
  parseMessage,
  listMessages,
  listHistory,
  ensureWatch,
  GmailApiError,
} from "./gmail.server";
import { classifyEmail, classifyEmailsBatch } from "./ai.server";
import { logError } from "./log.server";
import { computeLabelPatch } from "./sync/label-merge";
import {
  MAX_JOB_ATTEMPTS,
  RETRYABLE_FREE_ATTEMPTS,
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
import { updateEmailEncrypted } from "./sync/encrypted-writer";
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

// Re-export for backward compatibility with existing imports.
export const withAccountLock = _withAccountLock;
export const computeBackoffSeconds = _computeBackoffSeconds;
export const gmailHistoryIdGreater = _gmailHistoryIdGreater;
export const isTransientDlqError = _isTransientDlqError;
export const replayTransientDlq = _replayTransientDlq;
export const retryForwardAttempts = _retryForwardAttempts;
export { rescueStrandedEmails } from "./sync/rescue";
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
  const list = await listMessages(accountId, {
    maxResults,
    q: "-in:chats -in:trash -in:spam newer_than:30d",
  });
  const ids = (list.messages ?? []).map((m) => m.id);
  try {
    await enqueueMessageJobs(accountId, userId, ids, 0);
  } catch (e) {
    logError(
      "sync.backfill_recent_enqueue_failed",
      { account_id: accountId, user_id: userId, candidate_count: ids.length },
      e,
    );
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
      if (!seen.has(m.id)) {
        seen.add(m.id);
        ids.push(m.id);
      }
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
        logError(
          "sync.backfill_window_process_failed",
          { account_id: accountId, user_id: userId, gmail_message_id: todo[i] },
          e,
        );
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
    .select(
      "id, user_id, gmail_account_id, query, status, next_page_token, total_found, total_enqueued, already_had",
    )
    .in("status", ["listing", "processing"])
    .order("updated_at", { ascending: true })
    .limit(maxJobs);
  const results: Array<{ job_id: string; phase: string; added?: number; error?: string }> = [];
  for (const job of (jobs ?? []) as BackfillJob[]) {
    try {
      const r = await tickBackfillJob(job);
      results.push({ job_id: job.id, ...r });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      logError(
        "sync.tick_backfill_job_failed",
        { job_id: job.id, account_id: job.gmail_account_id, status: job.status },
        e,
      );
      await supabaseAdmin
        .from("backfill_jobs")
        .update({ last_error: message.slice(0, 500) })
        .eq("id", job.id);
      results.push({ job_id: job.id, phase: "error", error: message });
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
          logError(
            "sync.backfill_page_enqueue_failed",
            { job_id: job.id, account_id: job.gmail_account_id, batch_size: todo.length },
            e,
          );
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
  labelToFolder?: Map<string, { id: string; gmail_label_id: string | null }>,
) {
  if (added.includes("TRASH")) {
    await supabaseAdmin
      .from("emails")
      .delete()
      .eq("gmail_account_id", accountId)
      .eq("gmail_message_id", messageId);
    return;
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

// ─── Durable per-message processing queue ─────────────────────────────────
// Backoff constants + computeBackoffSeconds + jitter helper live in
// ./sync/backoff.ts (imported above). The constants are referenced by
// handleError below; jitter is also used by the forward-retry path.

export async function enqueueMessageJob(
  accountId: string,
  userId: string,
  gmailMessageId: string,
  priority: number = 0,
  opts: { publishedAtMs?: number | null } = {},
) {
  return enqueueMessageJobs(accountId, userId, [gmailMessageId], priority, opts);
}

/** Batched form — single upsert for N messages. Use this in any hot path
 * that enqueues more than one message per call (history sync, bootstrap,
 * backfill) so we don't pay one DB roundtrip per id.
 *
 * Caller-controlled jitter: next_run_at is staggered across 0–500ms so a
 * burst of N events doesn't collide on the same instant — multiple workers
 * claim disjoint slices instead of contending for the head of the queue.
 *
 * Upsert is idempotent — `ignoreDuplicates: true` means re-enqueueing an
 * already-pending message is a no-op. priority: 0 = live (push/poll),
 * 10 = backfill. */
export async function enqueueMessageJobs(
  accountId: string,
  userId: string,
  gmailMessageIds: string[],
  priority: number = 0,
  opts: { publishedAtMs?: number | null } = {},
) {
  if (gmailMessageIds.length === 0) return;
  const nowMs = Date.now();
  const publishedAtMs = opts.publishedAtMs ?? null;
  const rows = gmailMessageIds.map((gmail_message_id, idx) => ({
    gmail_account_id: accountId,
    gmail_message_id,
    user_id: userId,
    status: "pending",
    priority,
    // Spread across 0–500ms. For small bursts (N ≤ 500) each gets a
    // distinct ms slot; for larger bursts the modulo keeps it bounded.
    next_run_at: new Date(nowMs + (idx % 500)).toISOString(),
    published_at_ms: publishedAtMs,
  }));
  // Supabase caps a single upsert at ~1000 rows; we chunk just to be safe.
  for (let i = 0; i < rows.length; i += 500) {
    await supabaseAdmin.from("message_jobs").upsert(rows.slice(i, i + 500), {
      onConflict: "gmail_account_id,gmail_message_id",
      ignoreDuplicates: true,
    });
  }
}

export async function runMessageJobs(
  limit = 100,
  concurrency = 16,
  opts: { priority?: number } = {},
) {
  const STUCK_MS = 35 * 1000; // jobs in 'running' for >35s are presumed dead (worker timeout is 25s)
  const JOB_TIMEOUT_MS = 25 * 1000; // hard timeout for processGmailMessage

  // ─── Self-heal: reclaim any 'running' jobs whose worker died mid-execution.
  // Don't burn an attempt on the first reclaim — only count as a failure if the
  // last_error is already a reclaim marker (i.e. it died twice in a row).
  const stuckCutoff = new Date(Date.now() - STUCK_MS).toISOString();
  const { data: stuck } = await supabaseAdmin
    .from("message_jobs")
    .select("id, attempt, last_error")
    .eq("status", "running")
    .lt("locked_at", stuckCutoff);
  for (const s of stuck ?? []) {
    const wasReclaimed =
      typeof s.last_error === "string" && s.last_error.startsWith("stuck (worker timeout)");
    const nextAttempt = wasReclaimed ? (s.attempt ?? 0) + 1 : (s.attempt ?? 0);
    if (nextAttempt >= MAX_JOB_ATTEMPTS) {
      await supabaseAdmin
        .from("message_jobs")
        .update({
          status: "dlq",
          attempt: nextAttempt,
          last_error: "stuck (worker timeout — exceeded max attempts)",
          locked_at: null,
        })
        .eq("id", s.id);
    } else {
      await supabaseAdmin
        .from("message_jobs")
        .update({
          status: "pending",
          attempt: nextAttempt,
          last_error: "stuck (worker timeout) — auto-reclaimed",
          locked_at: null,
          next_run_at: new Date().toISOString(),
        })
        .eq("id", s.id);
    }
  }

  // ─── Atomic claim: single round-trip, parallel workers can't collide.
  const { data: claimedRows, error: claimErr } = await supabaseAdmin.rpc("claim_message_jobs", {
    p_limit: limit,
    p_priority: opts.priority ?? undefined,
  });
  if (claimErr) {
    logError(
      "sync.claim_message_jobs_rpc_failed",
      { limit, priority: opts.priority ?? null },
      claimErr,
    );
    return { processed: 0, ok: 0, failed: 0, dlq: 0, retryable: 0, error: claimErr.message };
  }
  type ClaimedJob = {
    id: string;
    gmail_account_id: string;
    gmail_message_id: string;
    user_id: string;
    attempt: number;
    priority: number;
    published_at_ms: number | null;
  };
  const claimed = (claimedRows ?? []) as ClaimedJob[];
  if (claimed.length === 0) {
    return { processed: 0, ok: 0, failed: 0, dlq: 0, retryable: 0 };
  }

  // ─── Prefetch per-account context once for the whole batch.
  const accountIds = Array.from(new Set(claimed.map((j) => j.gmail_account_id)));
  const userByAccount = new Map<string, string>();
  for (const j of claimed)
    if (!userByAccount.has(j.gmail_account_id)) userByAccount.set(j.gmail_account_id, j.user_id);
  const contextByAccount = new Map<string, AccountContext>();
  await Promise.all(
    accountIds.map(async (aid) => {
      try {
        contextByAccount.set(aid, await loadAccountContext(aid, userByAccount.get(aid)!));
      } catch (e) {
        logError(
          "sync.load_account_context_failed",
          { account_id: aid, user_id: userByAccount.get(aid) ?? null },
          e,
        );
      }
    }),
  );

  const results: Array<{
    id: string;
    ok: boolean;
    error?: string;
    dlq?: boolean;
    retryable?: boolean;
  }> = [];

  // After the first per-message pass, backfill messages still needing AI
  // are queued here for a single batched LLM call per account.
  type PendingAi = {
    job: ClaimedJob;
    emailRowId: string;
    parsed: Parameters<typeof classifyParsedEmail>[0];
  };
  const pendingAi: PendingAi[] = [];

  // If a job fails after processGmailMessage already inserted the email row
  // (e.g. classify hung past JOB_TIMEOUT_MS), the row is stuck at
  // classified_by='pending'. Stamp it to 'ai_error' so the realtime UPDATE
  // fires and the UI stops looking frozen. WHERE classified_by='pending'
  // guarantees we never overwrite a successful classification.
  const finalizeStuckEmailRow = async (job: ClaimedJob, errMsg: string) => {
    try {
      // Find the pending row for this job, then route the classification_reason
      // through the encrypted writer (plaintext column is dropped in Phase 3B).
      const { data: rows } = await supabaseAdmin
        .from("emails")
        .select("id")
        .eq("gmail_account_id", job.gmail_account_id)
        .eq("gmail_message_id", job.gmail_message_id)
        .eq("classified_by", "pending")
        .limit(1);
      const stuckId = rows?.[0]?.id;
      if (stuckId) {
        await updateEmailEncrypted({
          email_id: stuckId,
          classified_by: "ai_error",
          classification_reason: `Worker error: ${errMsg.slice(0, 300)}`,
        });
      }
    } catch (e) {
      logError(
        "sync.finalize_stuck_email_failed",
        {
          job_id: job.id,
          account_id: job.gmail_account_id,
          gmail_message_id: job.gmail_message_id,
        },
        e,
      );
    }
  };

  const handleError = async (job: ClaimedJob, e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    const status: number | undefined = e instanceof GmailApiError ? e.status : undefined;
    const retryable: boolean =
      e instanceof GmailApiError
        ? e.retryable
        : typeof msg === "string" && /timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
    const retryAfterSeconds: number | null =
      e instanceof GmailApiError ? e.retryAfterSeconds : null;
    const isQuotaExceeded: boolean = e instanceof GmailApiError ? e.isQuotaExceeded : false;

    await finalizeStuckEmailRow(job, msg);

    if (status === 404 || (typeof msg === "string" && msg.includes(" 404 "))) {
      await supabaseAdmin.from("message_jobs").delete().eq("id", job.id);
      results.push({ id: job.id, ok: true });
      return;
    }

    const terminal = status === 400 || status === 401 || status === 403;
    const currentAttempt = job.attempt ?? 0;
    const nextAttempt =
      retryable && currentAttempt < RETRYABLE_FREE_ATTEMPTS ? currentAttempt : currentAttempt + 1;

    if (terminal || nextAttempt >= MAX_JOB_ATTEMPTS) {
      let from_addr: string | null = null;
      let subject: string | null = null;
      try {
        const meta = await getMessageMetadata(job.gmail_account_id, job.gmail_message_id);
        const p = parseMessage(meta);
        from_addr = p.from_addr ?? null;
        subject = p.subject ?? null;
      } catch {
        /* best-effort */
      }
      await supabaseAdmin
        .from("message_jobs")
        .update({
          status: "dlq",
          attempt: nextAttempt,
          last_error: msg.slice(0, 1000),
          locked_at: null,
          from_addr,
          subject,
        })
        .eq("id", job.id);
      results.push({ id: job.id, ok: false, dlq: true, error: msg });
    } else {
      const backoffSeconds = computeBackoffSeconds({
        retryable,
        retryAfterSeconds,
        isQuotaExceeded,
        currentAttempt,
        nextAttempt,
      });
      await supabaseAdmin
        .from("message_jobs")
        .update({
          status: "pending",
          attempt: nextAttempt,
          last_error: msg.slice(0, 1000),
          locked_at: null,
          next_run_at: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
        })
        .eq("id", job.id);
      results.push({ id: job.id, ok: false, retryable, error: msg });
    }

    if (retryable && status && status !== 0) {
      try {
        await supabaseAdmin.from("pubsub_events").insert({
          event_type: "gmail_api_error",
          history_id: null,
          error: `Gmail API ${status}: ${msg.slice(0, 300)}`,
        });
      } catch {
        /* best-effort */
      }
    }
  };

  const processOne = async (job: ClaimedJob) => {
    const ctx = contextByAccount.get(job.gmail_account_id);
    // For backfill jobs (priority>=10) defer AI to the batched pass below.
    const deferAi = job.priority >= 10;
    const timings: ProcessTimings = { fetch: 0, ai: 0, db: 0 };
    try {
      const result = (await Promise.race([
        processGmailMessage(job.gmail_account_id, job.gmail_message_id, job.user_id, {
          context: ctx,
          skipAi: deferAi,
          timings,
          publishedAtMs: job.published_at_ms,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `job timeout after ${JOB_TIMEOUT_MS}ms (fetch=${timings.fetch.toFixed(0)} ai=${timings.ai.toFixed(0)} db=${timings.db.toFixed(0)})`,
                ),
              ),
            JOB_TIMEOUT_MS,
          ),
        ),
      ])) as Awaited<ReturnType<typeof processGmailMessage>>;

      // Queue for batched AI if this backfill row landed in Inbox (no folder yet)
      // and AI was deferred. We use classified_by check via the parsed result.
      if (
        deferAi &&
        result &&
        "email_id" in result &&
        result.email_id &&
        !result.folder_id &&
        result.parsed &&
        ctx &&
        ctx.folders.length > 0
      ) {
        pendingAi.push({ job, emailRowId: result.email_id, parsed: result.parsed });
        // Don't delete the job row yet — finalize after batch AI completes.
        return;
      }

      await supabaseAdmin.from("message_jobs").delete().eq("id", job.id);
      results.push({ id: job.id, ok: true });
    } catch (e: unknown) {
      await handleError(job, e);
    }
  };

  // ─── Pool of N workers draining the claimed queue.
  const queue = [...claimed];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) return;
      await processOne(job);
    }
  });
  await Promise.all(workers);

  // ─── Second pass: batched AI classification for backfill messages.
  // Group by account, chunk into batches of 8 emails per Gemini call.
  const BATCH_SIZE = 8;
  if (pendingAi.length > 0) {
    const byAccount = new Map<string, PendingAi[]>();
    for (const p of pendingAi) {
      if (!byAccount.has(p.job.gmail_account_id)) byAccount.set(p.job.gmail_account_id, []);
      byAccount.get(p.job.gmail_account_id)!.push(p);
    }
    await Promise.all(
      Array.from(byAccount.entries()).map(async ([aid, items]) => {
        const ctx = contextByAccount.get(aid);
        if (!ctx) return;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const chunk = items.slice(i, i + BATCH_SIZE);
          try {
            const out = await classifyEmailsBatch(
              chunk.map((c) => c.parsed),
              ctx.enrichedFolders,
            );
            await Promise.all(
              chunk.map(async (c, idx) => {
                const r = out[idx];
                // Honor each folder's min_ai_confidence — match live behavior.
                const candidate = r?.folder_id
                  ? ctx.folders.find((f) => f.id === r.folder_id)
                  : null;
                const threshold = candidate?.min_ai_confidence ?? 0;
                const passes = r?.folder_id && (r.confidence ?? 0) >= threshold;
                await updateEmailEncrypted({
                  email_id: c.emailRowId,
                  folder_id: passes ? r!.folder_id : null,
                  ai_summary: r?.summary || null,
                  ai_confidence: r?.confidence ?? 0,
                  classified_by: passes ? "ai" : r?.folder_id ? "ai_low_confidence" : "ai",
                  classification_reason: passes
                    ? r?.reason || null
                    : r?.folder_id
                      ? `AI suggested "${candidate?.name ?? "?"}" at ${((r?.confidence ?? 0) * 100).toFixed(0)}% < min ${(threshold * 100).toFixed(0)}%`
                      : r?.reason || null,
                });
                if (passes && r?.folder_id) void bumpEmailsSinceLearn(r.folder_id);
                await supabaseAdmin.from("message_jobs").delete().eq("id", c.job.id);
                results.push({ id: c.job.id, ok: true });
              }),
            );
          } catch (e: unknown) {
            // Batch failed — fall back to per-message classify so the queue still drains.
            logError(
              "sync.batch_ai_classify_failed",
              { account_id: aid, chunk_size: chunk.length },
              e,
            );
            await Promise.all(
              chunk.map(async (c) => {
                try {
                  const single = await classifyEmail(c.parsed, ctx.enrichedFolders);
                  await updateEmailEncrypted({
                    email_id: c.emailRowId,
                    folder_id: single.folder_id,
                    ai_summary: single.summary || null,
                    ai_confidence: single.confidence,
                    classified_by: "ai",
                    classification_reason: single.reason || null,
                  });
                  if (single.folder_id) void bumpEmailsSinceLearn(single.folder_id);
                  await supabaseAdmin.from("message_jobs").delete().eq("id", c.job.id);
                  results.push({ id: c.job.id, ok: true });
                } catch (innerErr: unknown) {
                  const innerMsg = innerErr instanceof Error ? innerErr.message : "unknown";
                  await updateEmailEncrypted({
                    email_id: c.emailRowId,
                    classified_by: "unclassified",
                    classification_reason: `AI classifier failed: ${innerMsg.slice(0, 200)}`,
                  });
                  await supabaseAdmin.from("message_jobs").delete().eq("id", c.job.id);
                  results.push({ id: c.job.id, ok: true });
                }
              }),
            );
          }
        }
      }),
    );
  }

  return {
    processed: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok && !r.dlq).length,
    dlq: results.filter((r) => r.dlq).length,
    retryable: results.filter((r) => r.retryable).length,
  };
}

export async function retryMessageJob(jobId: string) {
  await supabaseAdmin
    .from("message_jobs")
    .update({
      status: "pending",
      attempt: 0,
      locked_at: null,
      next_run_at: new Date().toISOString(),
    })
    .eq("id", jobId);
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
        const added = h.messagesAdded?.map((x) => x.message) ?? h.messages ?? [];
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

// (reconcileLocalInbox moved to ./sync/reconcile.ts and re-exported above.)

// Forward-retry + DLQ-replay logic lives in:
//   ./sync/forward-retry.ts → retryForwardAttempts
//   ./sync/dlq.ts          → isTransientDlqError, replayTransientDlq
// Both are re-exported at the top of this file for backward compat.
