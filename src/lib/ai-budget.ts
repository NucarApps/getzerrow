// Wall-clock budgeting for the AI classification cascade. Pure (no AI
// SDK imports) so it stays unit-testable.

/** Timeout (ms) for the next cascade attempt, or null when the total
 * budget is exhausted (< 500ms left — not worth starting a call). */
export function remainingAttemptTimeout(
  deadline: number,
  attemptMs: number,
  now = Date.now(),
): number | null {
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

/** Race a promise against a hard timeout so one stalled upstream call can't
 * hang the caller. Rejects with `${label} timed out after ${ms}ms`. */
export async function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
