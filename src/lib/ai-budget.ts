// Wall-clock budgeting for the AI classification cascade. Pure (no AI
// SDK imports) so it stays unit-testable.

/** Timeout (ms) for the next cascade attempt, or null when the total
 * budget is exhausted (< 500ms left — not worth starting a call). */
export function remainingAttemptTimeout(deadline: number, attemptMs: number, now = Date.now()): number | null {
  const remaining = deadline - now;
  if (remaining < 500) return null;
  return Math.min(attemptMs, remaining);
}

/** AbortSignal that fires after `ms`. AbortSignal.timeout where
 * available, controller+setTimeout fallback for older runtimes. */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new Error(`aborted after ${ms}ms`)), ms);
  return ctrl.signal;
}
