// Retry policy for folder_example_write.
//
// Folder learning should survive *transient* database hiccups (a dropped
// connection, a deadlock, a momentary connection-pool exhaustion) without a
// human noticing. It must NOT retry *permanent* failures — a schema mismatch
// like 42703 (undefined column) will fail identically every time, so retrying
// just wastes time and delays the alert. This module draws that line by
// Postgres SQLSTATE and computes exponential backoff with jitter.

/**
 * Postgres SQLSTATEs that represent transient conditions worth retrying.
 * Everything else (constraint violations, undefined column/table/function,
 * type errors) is treated as permanent.
 */
const TRANSIENT_SQLSTATES = new Set<string>([
  // Class 08 — Connection Exception
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
  "08007",
  // Class 40 — Transaction Rollback
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  // Class 53 — Insufficient Resources
  "53300", // too_many_connections
  "53400", // configuration_limit_exceeded
  // Class 55 — Object Not In Prerequisite State
  "55P03", // lock_not_available
  // Class 57 — Operator Intervention
  "57014", // query_canceled (statement timeout)
  "57P03", // cannot_connect_now
]);

// Network-layer failures from the fetch-based Supabase client often arrive
// with no SQLSTATE. These substrings identify the retryable ones.
const TRANSIENT_MESSAGE_PATTERNS = [
  "fetch failed",
  "network",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
  "timeout",
  "connection closed",
  "connection terminated",
];

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(err: unknown): string {
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === "string" ? msg : String(err ?? "");
}

/**
 * Decide whether a folder-example write error is worth retrying. A recognized
 * SQLSTATE is authoritative; when there is no code, fall back to matching known
 * network-failure messages. Unknown coded errors are treated as permanent so
 * schema regressions surface immediately instead of being masked by retries.
 */
export function isTransientWriteError(err: unknown): boolean {
  const code = errorCode(err);
  if (code) return TRANSIENT_SQLSTATES.has(code);
  const msg = errorMessage(err).toLowerCase();
  return TRANSIENT_MESSAGE_PATTERNS.some((p) => msg.includes(p));
}

export type BackoffOptions = {
  /** Delay for the first retry, in ms. Doubles each subsequent attempt. */
  baseMs?: number;
  /** Upper bound for the pre-jitter delay, in ms. */
  maxMs?: number;
  /** Jitter fraction in [0, 1). Injectable for deterministic tests. */
  rand?: number;
};

/**
 * Exponential backoff with "half jitter": the delay is half deterministic and
 * half random, so retries spread out (avoiding a thundering herd) while never
 * collapsing to zero. `attempt` is 1-based (1 = first retry).
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 100;
  const max = opts.maxMs ?? 2000;
  const rand = opts.rand ?? Math.random();
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const jittered = exp / 2 + rand * (exp / 2);
  return Math.round(jittered);
}

/** Promise-based sleep. Injectable so callers/tests can stub timing. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolved retry policy for folder-example writes. `maxAttempts` counts the
 * initial try plus retries (so 1 = no retries). `baseMs` is the first-retry
 * delay that `backoffDelayMs` doubles each subsequent attempt.
 */
export type RetryConfig = {
  maxAttempts: number;
  baseMs: number;
};

/** Built-in defaults used when the env vars are unset or invalid. */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseMs: 100,
};

// Safety rails so a fat-fingered env value can't wedge the pipeline: no
// unbounded retry storms and no multi-minute stalls per attempt.
const MAX_ATTEMPTS_CEILING = 10;
const BASE_MS_CEILING = 60_000;

/** Parse a positive integer env value, clamped to [min, max]. */
function parseClampedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Resolve the folder-write retry policy from the environment so resilience can
 * be tuned without a redeploy:
 *   - FOLDER_WRITE_MAX_ATTEMPTS  (int, clamped to [1, 10], default 3)
 *   - FOLDER_WRITE_BACKOFF_BASE_MS (int ms, clamped to [1, 60000], default 100)
 *
 * Invalid or missing values fall back to DEFAULT_RETRY_CONFIG. `env` is
 * injectable for deterministic tests; it defaults to process.env and MUST be
 * read at call time (never at module scope) so Worker env injection applies.
 */
export function resolveRetryConfig(
  env: Record<string, string | undefined> = process.env,
): RetryConfig {
  return {
    maxAttempts: parseClampedInt(
      env.FOLDER_WRITE_MAX_ATTEMPTS,
      DEFAULT_RETRY_CONFIG.maxAttempts,
      1,
      MAX_ATTEMPTS_CEILING,
    ),
    baseMs: parseClampedInt(
      env.FOLDER_WRITE_BACKOFF_BASE_MS,
      DEFAULT_RETRY_CONFIG.baseMs,
      1,
      BASE_MS_CEILING,
    ),
  };
}

