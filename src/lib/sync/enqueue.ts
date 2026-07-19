// Durable per-message processing queue: enqueue and manual-retry.
// Extracted from sync.server.ts so callers can import the queue
// primitives without pulling in the full sync graph.
//
// Job priority: 0 = live (push/poll), 10 = backfill.
//
// Every enqueue/retry emits a structured log line so a single email
// can be traced across enqueue → claim → run → complete/DLQ using
// (gmail_account_id, gmail_message_id) or job_id.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logInfo, logError } from "../log.server";

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
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabaseAdmin.from("message_jobs").upsert(chunk, {
      onConflict: "gmail_account_id,gmail_message_id",
      ignoreDuplicates: true,
    });
    if (error) {
      logError(
        "queue.enqueue.failed",
        {
          account_id: accountId,
          user_id: userId,
          priority,
          chunk_size: chunk.length,
          total: gmailMessageIds.length,
        },
        error,
      );
      throw error;
    }
  }
  logInfo("queue.enqueue", {
    account_id: accountId,
    user_id: userId,
    priority,
    count: gmailMessageIds.length,
    published_at_ms: publishedAtMs,
    // First few ids only — bounded cardinality, still lets you grep one message.
    sample_message_ids: gmailMessageIds.slice(0, 5),
  });
}

/** Operator-triggered retry: reset a job back to the head of the queue.
 *  Used by the DLQ replay endpoint and the settings "retry" button. */
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
  logInfo("queue.retry", { job_id: jobId, source: "manual" });
}
