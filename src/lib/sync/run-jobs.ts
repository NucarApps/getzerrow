// Message-jobs queue drainer. Claims pending jobs via the atomic
// claim_message_jobs RPC (SKIP LOCKED + 60s lease), runs them through
// processGmailMessage with a hard per-job timeout, and either deletes
// the row on success, requeues with backoff on transient errors, or
// pushes to DLQ on terminal failure.
//
// Two AI paths:
//   inline — one AI call per message (small live claim, needs_ai path)
//   batched (deferAi) — group by account, one LLM call per 8 messages.
//                       Used for backfill priority=10 and for live-lane
//                       bursts (≥ LIVE_BATCH_AI_THRESHOLD claimed at once).
//                       Also used when deferAiToCron=true (webhook drain
//                       requeues onto the 5s live cron).
//
// The stuck-job reclaim at the top is our self-heal: a worker that dies
// mid-execution leaves status='running'/locked_at set; after STUCK_MS
// we reclaim it, and only count it as a failed attempt on the SECOND
// reclaim (so one accidental worker kill doesn't burn a retry).
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMessageMetadata, parseMessage, GmailApiError } from "../gmail.server";
import { classifyEmail, classifyEmailsBatch } from "../ai.server";
import { logError } from "../log.server";
import { MAX_JOB_ATTEMPTS, RETRYABLE_FREE_ATTEMPTS, computeBackoffSeconds } from "./backoff";
import {
  type AccountContext,
  loadAccountContext,
} from "./account-context";
import { classifyParsedEmail } from "./classify";
import { updateEmailEncrypted } from "./encrypted-writer";
import { bumpEmailsSinceLearn } from "./folder-learn";
import {
  applyFolderActions,
  processGmailMessage,
  type ActionFolder,
  type ProcessTimings,
} from "./process-message";
import {
  JOB_WORKER_CONCURRENCY,
  LIVE_BATCH_AI_THRESHOLD,
  WEBHOOK_DEFERRED_AI_REQUEUE_MS,
} from "./config";

function resolveActionFolderFromContext(
  context: AccountContext | undefined,
  folderId: string | null | undefined,
): ActionFolder | null {
  if (!context || !folderId) return null;
  const cached = context.folders.find((f) => f.id === folderId);
  if (!cached) return null;
  return {
    id: cached.id,
    gmail_label_id: cached.gmail_label_id,
    auto_archive: cached.auto_archive,
    auto_mark_read: cached.auto_mark_read,
    auto_star: cached.auto_star,
    hide_from_inbox: cached.hide_from_inbox,
    forward_to: cached.forward_to,
    snooze_hours: cached.snooze_hours,
  };
}

async function applyClassifiedFolderActions(
  job: { gmail_account_id: string; gmail_message_id: string },
  emailRowId: string,
  parsed: Parameters<typeof classifyParsedEmail>[0],
  folder: ActionFolder | null,
): Promise<void> {
  if (!folder) return;
  await applyFolderActions(
    job.gmail_account_id,
    job.gmail_message_id,
    emailRowId,
    folder,
    {
      raw_labels: parsed.raw_labels,
      subject: parsed.subject,
      from_addr: parsed.from_addr,
      from_name: parsed.from_name,
      received_at: parsed.received_at,
      body_text: parsed.body_text,
      snippet: parsed.snippet,
    },
    (parsed.raw_labels ?? []).includes("INBOX"),
    { persistFlags: true },
  );
}

export async function runMessageJobs(
  limit = 100,
  concurrency = JOB_WORKER_CONCURRENCY,
  opts: { priority?: number; deferAiToCron?: boolean } = {},
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

  // Under a burst, route the live lane's AI step through the batched
  // classifier (8/call) instead of N inline AI calls. A single new email
  // (claim batch below the threshold) keeps its inline, instant-folder
  // behavior. The batched second pass below applies folder side-effects.
  const liveBurst = claimed.length >= LIVE_BATCH_AI_THRESHOLD;

  // Webhook drain mode: insert rows now (fires realtime instantly) and hand
  // the AI step to the 5s live cron instead of running it inside the push
  // request. Keeps push → ack well under Pub/Sub's ~10s redelivery deadline.
  const deferAiToCron = opts.deferAiToCron === true;

  const processOne = async (job: ClaimedJob) => {
    const ctx = contextByAccount.get(job.gmail_account_id);
    // Backfill jobs (priority>=10) always defer AI to the batched pass; live
    // mail defers only during a burst so big bursts batch instead of doing
    // one slow inline AI call per message. The webhook drain (deferAiToCron)
    // always defers so the ack isn't blocked on AI.
    const deferAi = deferAiToCron || job.priority >= 10 || liveBurst;
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

      const needsAiPass =
        result &&
        "email_id" in result &&
        result.email_id &&
        "needs_ai" in result &&
        result.needs_ai === true &&
        result.parsed &&
        ctx &&
        ctx.folders.length > 0;

      // Webhook drain: the row is inserted and visible; requeue the job so
      // the live cron finishes the AI classification out-of-band. A short
      // future next_run_at stops the webhook's own remaining rounds from
      // re-claiming it (which would re-fetch in a loop).
      if (deferAiToCron && needsAiPass) {
        await supabaseAdmin
          .from("message_jobs")
          .update({
            status: "pending",
            locked_at: null,
            next_run_at: new Date(Date.now() + WEBHOOK_DEFERRED_AI_REQUEUE_MS).toISOString(),
          })
          .eq("id", job.id);
        results.push({ id: job.id, ok: true });
        return;
      }

      // Queue for batched AI only when the message actually needs the AI
      // pass (needs_ai === true). Using needs_ai instead of `!folder_id`
      // avoids re-classifying excluded/blocklisted rows (folder_id null but
      // FINAL) and overwriting the user's decision.
      if (deferAi && needsAiPass) {
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
                if (passes && r?.folder_id) {
                  const folder = resolveActionFolderFromContext(ctx, r.folder_id);
                  await applyClassifiedFolderActions(c.job, c.emailRowId, c.parsed, folder);
                }
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
                if (passes && r?.folder_id) {
                  void bumpEmailsSinceLearn(r.folder_id);
                }
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
                  if (single.folder_id) {
                    const folder = resolveActionFolderFromContext(ctx, single.folder_id);
                    await applyClassifiedFolderActions(c.job, c.emailRowId, c.parsed, folder);
                  }
                  await updateEmailEncrypted({
                    email_id: c.emailRowId,
                    folder_id: single.folder_id,
                    ai_summary: single.summary || null,
                    ai_confidence: single.confidence,
                    classified_by: "ai",
                    classification_reason: single.reason || null,
                  });
                  if (single.folder_id) {
                    void bumpEmailsSinceLearn(single.folder_id);
                  }
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
