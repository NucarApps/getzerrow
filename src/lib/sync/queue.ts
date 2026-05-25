// Durable per-message processing queue.
//
// FLOW
//   enqueueMessageJob / enqueueMessageJobs upsert rows into message_jobs.
//   runMessageJobs is the worker:
//     1. Self-heal: reclaims rows stuck in 'running' past JOB_TIMEOUT_MS
//        + STUCK_MS grace. Worker died → row drifts back to pending
//        without burning an attempt unless it's already a repeat.
//     2. Atomic claim via claim_message_jobs RPC (FOR UPDATE SKIP LOCKED
//        + status=running stamp). Multiple workers can drain in
//        parallel without re-claiming each other's rows.
//     3. Prefetch per-account context once for the whole batch so the
//        N processGmailMessage calls share one folders+filters fetch.
//     4. Concurrent processing pool. Each call is wrapped in a hard
//        25s timeout — Cloudflare Workers' wall-time limit means we
//        must give up on slow Gmail/AI calls before they kill the
//        whole batch.
//     5. Backfill messages defer AI to a second pass: the worker pool
//        finishes the cheap parts (insert + filter-based classify)
//        then we batch the still-unclassified messages 8-per-call to
//        the AI gateway, ONE call per chunk instead of N.
//
// PRIORITY LANES
//   priority=0 (live mail from push/poll) jumps ahead of priority=10
//   (backfill). The claim RPC orders by priority ASC. Live mail
//   classifies inline (cheap + fast); backfill defers to the batched
//   AI pass to amortize Gemini cost.
//
// FAILURE HANDLING
//   handleError classifies the error:
//     * 404 = message gone, delete the job row, succeed silently
//     * 400 / 401 / 403 = terminal → DLQ on first occurrence
//     * 429 / 5xx / network = retryable → backoff via
//       computeBackoffSeconds, first 2 retryable attempts are free
//       (don't increment attempt) so a flaky Gmail API doesn't bury
//       messages
//     * After MAX_JOB_ATTEMPTS, anything goes to DLQ with the from /
//       subject metadata fetched for the operator UI.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { GmailApiError, getMessageMetadata, parseMessage } from "../gmail.server";
import { classifyEmail, classifyEmailsBatch } from "../ai.server";
import {
  MAX_JOB_ATTEMPTS, RETRYABLE_FREE_ATTEMPTS, computeBackoffSeconds,
} from "./backoff";
import { type AccountContext, loadAccountContext } from "./account-context";
import { bumpEmailsSinceLearn } from "./folder-learn";
import { processGmailMessage, type ProcessTimings } from "./process-message";
import type { classifyParsedEmail } from "./classify";

export async function enqueueMessageJob(
  accountId: string,
  userId: string,
  gmailMessageId: string,
  priority: number = 0,
  opts: { publishedAtMs?: number | null } = {},
) {
  return enqueueMessageJobs(accountId, userId, [gmailMessageId], priority, opts);
}

/** Batched form — single upsert for N messages. Use this in any hot
 * path that enqueues more than one message per call (history sync,
 * bootstrap, backfill) so we don't pay one DB roundtrip per id.
 *
 * Caller-controlled jitter: next_run_at is staggered across 0–500ms so
 * a burst of N events doesn't collide on the same instant — multiple
 * workers claim disjoint slices instead of contending for the head of
 * the queue.
 *
 * Upsert is idempotent — `ignoreDuplicates: true` means re-enqueueing
 * an already-pending message is a no-op. priority: 0 = live
 * (push/poll), 10 = backfill. */
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
    next_run_at: new Date(nowMs + (idx % 500)).toISOString(),
    published_at_ms: publishedAtMs,
  }));
  // Supabase caps a single upsert at ~1000 rows; we chunk just to be safe.
  for (let i = 0; i < rows.length; i += 500) {
    await supabaseAdmin
      .from("message_jobs")
      .upsert(rows.slice(i, i + 500), {
        onConflict: "gmail_account_id,gmail_message_id",
        ignoreDuplicates: true,
      });
  }
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

type ProcessResult = {
  id: string;
  ok: boolean;
  error?: string;
  dlq?: boolean;
  retryable?: boolean;
};

export async function runMessageJobs(
  limit = 100,
  concurrency = 16,
  opts: { priority?: number } = {},
) {
  const STUCK_MS = 35 * 1000; // jobs in 'running' for >35s are presumed dead (worker timeout is 25s)
  const JOB_TIMEOUT_MS = 25 * 1000; // hard timeout for processGmailMessage

  // ─── Self-heal: reclaim 'running' jobs whose worker died mid-execution.
  // Don't burn an attempt on the first reclaim — only count as a
  // failure if the last_error is already a reclaim marker (i.e. it
  // died twice in a row).
  await reclaimStuckJobs(STUCK_MS);

  // ─── Atomic claim: single round-trip, parallel workers can't collide.
  type ClaimRpc = {
    rpc: (fn: "claim_message_jobs", args: { p_limit: number; p_priority?: number }) => Promise<{
      data: ClaimedJob[] | null;
      error: { message: string } | null;
    }>;
  };
  const { data: claimedRows, error: claimErr } = await (supabaseAdmin as unknown as ClaimRpc).rpc(
    "claim_message_jobs",
    { p_limit: limit, p_priority: opts.priority ?? undefined },
  );
  if (claimErr) {
    console.error("claim_message_jobs RPC failed", claimErr);
    return { processed: 0, ok: 0, failed: 0, dlq: 0, retryable: 0, error: claimErr.message };
  }
  const claimed = (claimedRows ?? []) as ClaimedJob[];
  if (claimed.length === 0) {
    return { processed: 0, ok: 0, failed: 0, dlq: 0, retryable: 0 };
  }

  // ─── Prefetch per-account context once for the whole batch.
  const accountIds = Array.from(new Set(claimed.map((j) => j.gmail_account_id)));
  const userByAccount = new Map<string, string>();
  for (const j of claimed) if (!userByAccount.has(j.gmail_account_id)) userByAccount.set(j.gmail_account_id, j.user_id);
  const contextByAccount = new Map<string, AccountContext>();
  await Promise.all(
    accountIds.map(async (aid) => {
      try {
        contextByAccount.set(aid, await loadAccountContext(aid, userByAccount.get(aid)!));
      } catch (e) {
        console.error("loadAccountContext failed", aid, e);
      }
    }),
  );

  const results: ProcessResult[] = [];

  // After the first per-message pass, backfill messages still needing
  // AI are queued here for a single batched LLM call per account.
  type PendingAi = {
    job: ClaimedJob;
    emailRowId: string;
    parsed: Parameters<typeof classifyParsedEmail>[0];
  };
  const pendingAi: PendingAi[] = [];

  const processOne = async (job: ClaimedJob) => {
    const ctx = contextByAccount.get(job.gmail_account_id);
    // Backfill jobs (priority>=10) defer AI to the batched pass below.
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
            () => reject(new Error(
              `job timeout after ${JOB_TIMEOUT_MS}ms (fetch=${timings.fetch.toFixed(0)} ai=${timings.ai.toFixed(0)} db=${timings.db.toFixed(0)})`,
            )),
            JOB_TIMEOUT_MS,
          ),
        ),
      ])) as Awaited<ReturnType<typeof processGmailMessage>>;

      // Queue for batched AI if this backfill row landed in Inbox (no
      // folder yet) and AI was deferred.
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
      await handleError(job, e, results);
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
  await drainPendingAi(pendingAi, contextByAccount, results);

  return {
    processed: results.length,
    ok: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok && !r.dlq).length,
    dlq: results.filter(r => r.dlq).length,
    retryable: results.filter(r => r.retryable).length,
  };
}

export async function retryMessageJob(jobId: string) {
  await supabaseAdmin.from("message_jobs").update({
    status: "pending",
    attempt: 0,
    locked_at: null,
    next_run_at: new Date().toISOString(),
  }).eq("id", jobId);
}

// ─── Internal helpers ────────────────────────────────────────────────────

async function reclaimStuckJobs(stuckMs: number) {
  const stuckCutoff = new Date(Date.now() - stuckMs).toISOString();
  const { data: stuck } = await supabaseAdmin
    .from("message_jobs")
    .select("id, attempt, last_error")
    .eq("status", "running")
    .lt("locked_at", stuckCutoff);
  for (const s of stuck ?? []) {
    const wasReclaimed = typeof s.last_error === "string" && s.last_error.startsWith("stuck (worker timeout)");
    const nextAttempt = wasReclaimed ? (s.attempt ?? 0) + 1 : (s.attempt ?? 0);
    if (nextAttempt >= MAX_JOB_ATTEMPTS) {
      await supabaseAdmin.from("message_jobs").update({
        status: "dlq",
        attempt: nextAttempt,
        last_error: "stuck (worker timeout — exceeded max attempts)",
        locked_at: null,
      }).eq("id", s.id);
    } else {
      await supabaseAdmin.from("message_jobs").update({
        status: "pending",
        attempt: nextAttempt,
        last_error: "stuck (worker timeout) — auto-reclaimed",
        locked_at: null,
        next_run_at: new Date().toISOString(),
      }).eq("id", s.id);
    }
  }
}

async function handleError(
  job: ClaimedJob,
  e: unknown,
  results: ProcessResult[],
): Promise<void> {
  const msg = (e as Error)?.message ?? String(e);
  const status: number | undefined = e instanceof GmailApiError ? e.status : undefined;
  const retryable: boolean = e instanceof GmailApiError
    ? e.retryable
    : (typeof msg === "string" && /timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg));
  const retryAfterSeconds: number | null = e instanceof GmailApiError ? e.retryAfterSeconds : null;
  const isQuotaExceeded: boolean = e instanceof GmailApiError ? e.isQuotaExceeded : false;

  // 404 = message gone from Gmail (user deleted in another client) —
  // succeed silently, nothing to process.
  if (status === 404 || (typeof msg === "string" && msg.includes(" 404 "))) {
    await supabaseAdmin.from("message_jobs").delete().eq("id", job.id);
    results.push({ id: job.id, ok: true });
    return;
  }

  const terminal = status === 400 || status === 401 || status === 403;
  const currentAttempt = job.attempt ?? 0;
  const nextAttempt = retryable && currentAttempt < RETRYABLE_FREE_ATTEMPTS
    ? currentAttempt
    : currentAttempt + 1;

  if (terminal || nextAttempt >= MAX_JOB_ATTEMPTS) {
    // Park in DLQ with from/subject for the operator UI.
    let from_addr: string | null = null;
    let subject: string | null = null;
    try {
      const meta = await getMessageMetadata(job.gmail_account_id, job.gmail_message_id);
      const p = parseMessage(meta);
      from_addr = p.from_addr ?? null;
      subject = p.subject ?? null;
    } catch { /* best-effort */ }
    await supabaseAdmin.from("message_jobs").update({
      status: "dlq",
      attempt: nextAttempt,
      last_error: msg.slice(0, 1000),
      locked_at: null,
      from_addr,
      subject,
    }).eq("id", job.id);
    results.push({ id: job.id, ok: false, dlq: true, error: msg });
  } else {
    const backoffSeconds = computeBackoffSeconds({
      retryable,
      retryAfterSeconds,
      isQuotaExceeded,
      currentAttempt,
      nextAttempt,
    });
    await supabaseAdmin.from("message_jobs").update({
      status: "pending",
      attempt: nextAttempt,
      last_error: msg.slice(0, 1000),
      locked_at: null,
      next_run_at: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
    }).eq("id", job.id);
    results.push({ id: job.id, ok: false, retryable, error: msg });
  }

  // Gmail API errors flow into the activity feed so the operator can
  // see "we hit 429 4 times in the last hour" without grepping logs.
  if (retryable && status && status !== 0) {
    try {
      await supabaseAdmin.from("pubsub_events").insert({
        event_type: "gmail_api_error",
        history_id: null,
        error: `Gmail API ${status}: ${msg.slice(0, 300)}`,
      });
    } catch { /* best-effort */ }
  }
}

type PendingAi = {
  job: ClaimedJob;
  emailRowId: string;
  parsed: Parameters<typeof classifyParsedEmail>[0];
};

async function drainPendingAi(
  pendingAi: PendingAi[],
  contextByAccount: Map<string, AccountContext>,
  results: ProcessResult[],
) {
  if (pendingAi.length === 0) return;
  const BATCH_SIZE = 8;
  // Group by account so each batched LLM call uses the right
  // folder/example context.
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
          const out = await classifyEmailsBatch(chunk.map((c) => c.parsed), ctx.enrichedFolders);
          await Promise.all(
            chunk.map(async (c, idx) => {
              const r = out[idx];
              // Honor each folder's min_ai_confidence — match live behavior.
              const candidate = r?.folder_id ? ctx.folders.find((f) => f.id === r.folder_id) : null;
              const threshold = candidate?.min_ai_confidence ?? 0;
              const passes = r?.folder_id && (r.confidence ?? 0) >= threshold;
              await supabaseAdmin.from("emails").update({
                folder_id: passes ? r!.folder_id : null,
                ai_summary: r?.summary || null,
                ai_confidence: r?.confidence ?? 0,
                classified_by: passes ? "ai" : (r?.folder_id ? "ai_low_confidence" : "ai"),
                classification_reason: passes
                  ? (r?.reason || null)
                  : (r?.folder_id
                      ? `AI suggested "${candidate?.name ?? "?"}" at ${((r?.confidence ?? 0) * 100).toFixed(0)}% < min ${(threshold * 100).toFixed(0)}%`
                      : (r?.reason || null)),
              }).eq("id", c.emailRowId);
              if (passes && r?.folder_id) void bumpEmailsSinceLearn(r.folder_id);
              await supabaseAdmin.from("message_jobs").delete().eq("id", c.job.id);
              results.push({ id: c.job.id, ok: true });
            }),
          );
        } catch (e: unknown) {
          // Batch failed — fall back to per-message classify so the
          // queue still drains.
          console.error("batch AI classify failed, falling back per-message", (e as Error)?.message ?? e);
          await Promise.all(
            chunk.map(async (c) => {
              try {
                const single = await classifyEmail(c.parsed, ctx.enrichedFolders);
                await supabaseAdmin.from("emails").update({
                  folder_id: single.folder_id,
                  ai_summary: single.summary || null,
                  ai_confidence: single.confidence,
                  classified_by: "ai",
                  classification_reason: single.reason || null,
                }).eq("id", c.emailRowId);
                if (single.folder_id) void bumpEmailsSinceLearn(single.folder_id);
                await supabaseAdmin.from("message_jobs").delete().eq("id", c.job.id);
                results.push({ id: c.job.id, ok: true });
              } catch (innerErr: unknown) {
                await supabaseAdmin.from("emails").update({
                  classified_by: "unclassified",
                  classification_reason: `AI classifier failed: ${((innerErr as Error)?.message ?? "unknown").slice(0, 200)}`,
                }).eq("id", c.emailRowId);
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
