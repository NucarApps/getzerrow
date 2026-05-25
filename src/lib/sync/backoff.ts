// Backoff policy for the message_jobs queue and forward-retry path.
//
// All public values:
//   MAX_JOB_ATTEMPTS         max attempts before a job is parked in DLQ
//   BACKOFF_SECONDS          backoff table for terminal failures
//   RETRYABLE_BACKOFF_SECONDS backoff table for transient failures (429/5xx)
//   RETRYABLE_FREE_ATTEMPTS  number of retryable failures that don't count
//                            toward MAX_JOB_ATTEMPTS (so a flaky Gmail API
//                            doesn't quickly bury messages in DLQ)
//   jitter(seconds)          ±25% randomization helper
//   computeBackoffSeconds(opts)
//                            pure decision: how long to wait before next
//                            retry, respecting (in order) Retry-After,
//                            quotaExceeded, the retryable/terminal table,
//                            and attempt index.

export const MAX_JOB_ATTEMPTS = 5;

// Terminal-failure backoff. 30s → 2m → 10m → 30m → 2h. Used when the
// error wasn't classified as retryable.
export const BACKOFF_SECONDS = [30, 120, 600, 1800, 7200];

// Transient-failure backoff. 30s → 1.5m → 5m → 15m → 1h. Used for 429s
// and 5xx, which are usually shorter outages.
export const RETRYABLE_BACKOFF_SECONDS = [30, 90, 300, 900, 3600];

// First N retryable failures don't increment `attempt`, so a flaky Google
// API won't burn a message into DLQ during a short outage.
export const RETRYABLE_FREE_ATTEMPTS = 2;

/** ±25% jitter — keeps a burst of jobs scheduled at the same backoff from
 * all firing at the same instant. */
export function jitter(seconds: number): number {
  return Math.floor(seconds * (0.75 + Math.random() * 0.5));
}

/** Seconds until midnight US/Pacific. Gmail per-user quotas reset at
 * midnight PT, so quotaExceeded backoff anchors here. DST-aware via Intl.
 * Returns a safe 4h fallback if Intl yields an unparseable value. */
export function secondsUntilMidnightPT(now = new Date()): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
    const h = parseInt(parts.hour ?? "", 10);
    const m = parseInt(parts.minute ?? "", 10);
    const s = parseInt(parts.second ?? "", 10);
    if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) {
      return 4 * 3600;
    }
    const elapsed = h * 3600 + m * 60 + s;
    return Math.max(60, 86400 - elapsed);
  } catch {
    return 4 * 3600;
  }
}

/** Pick a backoff that respects, in order:
 *    1. Retry-After header (parsed by gmail.server.ts)
 *    2. quotaExceeded (wait until midnight PT, capped at 6h)
 *    3. retryable vs terminal table, attempt index
 * Always jittered. */
export function computeBackoffSeconds(opts: {
  retryable: boolean;
  retryAfterSeconds: number | null;
  isQuotaExceeded: boolean;
  currentAttempt: number;
  nextAttempt: number;
}): number {
  if (opts.retryAfterSeconds && opts.retryAfterSeconds > 0) {
    return jitter(opts.retryAfterSeconds);
  }
  if (opts.isQuotaExceeded) {
    // Hard upper bound at 6h. Without jitter, a hundred jobs all queued at
    // the same quota event would retry at the exact same instant and
    // likely re-trigger the same quota — so apply ±25% jitter.
    return jitter(Math.min(secondsUntilMidnightPT(), 6 * 3600));
  }
  const table = opts.retryable ? RETRYABLE_BACKOFF_SECONDS : BACKOFF_SECONDS;
  const idx = opts.retryable
    ? Math.min(opts.currentAttempt, table.length - 1)
    : Math.min(opts.nextAttempt - 1, table.length - 1);
  return jitter(table[idx]);
}
