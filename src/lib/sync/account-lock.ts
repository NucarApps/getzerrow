// Per-account in-process coalescing lock.
//
// Pub/Sub redeliveries and the polling cron can trigger overlapping
// syncSinceHistory calls for the same account. Without coalescing, the
// second caller reads a stale history_id and either redoes work or
// skips events. withAccountLock pipes overlapping callers through a
// single shared promise — first writer wins.
//
// Scope: per-process. Cross-process safety is enforced separately by
// the bump_history_id_if_greater SQL guard and claim_message_jobs'
// FOR UPDATE SKIP LOCKED. In-process coalescing is still valuable
// because a hot Pub/Sub mailbox can fire 10s of pushes per second to
// the same worker.

const syncLocks = new Map<string, Promise<unknown>>();

export function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const existing = syncLocks.get(accountId);
  if (existing) return existing as Promise<T>;
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
