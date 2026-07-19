// DLQ auto-replay.
//
// Jobs that hit MAX_JOB_ATTEMPTS retryable failures land in DLQ
// (status='dlq'). A one-off Gmail 5xx outage from a few hours ago can
// park hundreds of messages there. Rather than waiting for manual
// operator clicks, replayTransientDlq finds rows whose `last_error`
// looks transient (5xx, 429, timeout, network reset) and flips them
// back to pending with a fresh attempt counter and a spread-out
// next_run_at.
//
// isTransientDlqError is exported pure so the SLO contract (which
// failure shapes count as transient) can be unit-tested.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const TRANSIENT_DLQ_PATTERNS = [
  /\b5\d{2}\b/,
  /timeout/i,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bfetch failed\b/,
  /\b429\b/,
  /unavailable/i,
  // Worker died mid-processing (Cloudflare 25s wall-time). Reclaim path
  // parks these in DLQ; treat as transient so a one-off burst drains.
  /stuck \(worker timeout/i,
];

/** Pure: does this DLQ `last_error` string look transient enough to
 * auto-replay? Permanent failures (4xx, parse errors, classifier
 * failures) are excluded — operators investigate those manually. */
export function isTransientDlqError(lastError: string | null | undefined): boolean {
  if (typeof lastError !== "string" || lastError.length === 0) return false;
  return TRANSIENT_DLQ_PATTERNS.some((p) => p.test(lastError));
}

/** Walks recent DLQ rows; for each transient-looking entry, runs a
 * conditional UPDATE that only commits if the row is STILL in dlq
 * (defends against a concurrent replayer flipping it to running between
 * our select and update). Replay times are spread across 10min so a big
 * chunk doesn't hammer Gmail all at once. */
export async function replayTransientDlq(maxRows = 200) {
  const { data: rows } = await supabaseAdmin
    .from("message_jobs")
    .select("id, last_error, attempt")
    .eq("status", "dlq")
    .order("updated_at", { ascending: false })
    .limit(maxRows);
  let replayed = 0;
  let skipped = 0;
  for (const row of rows ?? []) {
    if (!isTransientDlqError(row.last_error)) {
      skipped++;
      continue;
    }
    const { data: updated } = await supabaseAdmin
      .from("message_jobs")
      .update({
        status: "pending",
        attempt: 0,
        locked_at: null,
        next_run_at: new Date(
          Date.now() + Math.floor(Math.random() * 10 * 60 * 1000),
        ).toISOString(),
        last_error: `auto-replayed from DLQ at ${new Date().toISOString()} (was: ${row.last_error?.slice(0, 200) ?? ""})`,
      })
      .eq("id", row.id)
      .eq("status", "dlq")
      .select("id");
    if (updated && updated.length > 0) replayed++;
    else skipped++;
  }
  return { checked: rows?.length ?? 0, replayed, skipped };
}
