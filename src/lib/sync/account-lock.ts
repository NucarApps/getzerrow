// Per-account in-process coalescing lock.
//
// Pub/Sub redeliveries and the polling cron can trigger overlapping
// syncSinceHistory calls for the same account. Without coalescing, the
// second caller reads a stale history_id and either redoes work or
// skips events.
//
// Overlap handling: the in-flight run may have issued its listHistory
// BEFORE the event that triggered the overlapping caller — simply
// returning the in-flight promise would swallow that event until the
// next poll tick (a 2-minute latency cliff on exactly the rapid-burst
// case where the user is watching the inbox). So an overlapping caller
// chains exactly ONE follow-up run after the current one finishes, and
// every further overlapping caller coalesces onto that same follow-up.
//
// Scope: per-process. Cross-process safety is enforced separately by
// the bump_history_id_if_greater SQL guard and claim_message_jobs'
// FOR UPDATE SKIP LOCKED. In-process coalescing is still valuable
// because a hot Pub/Sub mailbox can fire 10s of pushes per second to
// the same worker.

const syncLocks = new Map<string, Promise<unknown>>();
const pendingReruns = new Map<string, Promise<unknown>>();

export function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const existing = syncLocks.get(accountId);
  if (existing) {
    const rerun = pendingReruns.get(accountId);
    if (rerun) return rerun as Promise<T>;
    const followUp = existing
      .catch(() => {
        /* the in-flight run's failure belongs to its own callers */
      })
      .then(() => {
        pendingReruns.delete(accountId);
        return withAccountLock(accountId, fn);
      });
    pendingReruns.set(accountId, followUp);
    return followUp as Promise<T>;
  }
  const p = (async () => {
    try {
      return await fn();
    } finally {
      syncLocks.delete(accountId);
    }
  })();
  syncLocks.set(accountId, p);
  return p;
}
