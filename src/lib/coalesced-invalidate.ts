// Trailing-edge coalescer for TanStack Query invalidations. Several
// independent signals (damaged realtime pushes, visibility catch-ups,
// self-heal loops) can all conclude "the email lists might be stale" within
// the same second; each invalidation re-runs the server-side decrypt
// round-trip. Funnel them here so a burst costs one flush, and flushes are
// never closer together than `minIntervalMs`.

export type CoalescedInvalidator = {
  /** Queue a query key for invalidation. Duplicate keys inside a window
   * collapse to one. */
  request: (key: readonly unknown[]) => void;
  /** Cancel any pending flush and drop queued keys. */
  dispose: () => void;
};

export function createCoalescedInvalidator(
  flush: (keys: (readonly unknown[])[]) => void,
  opts: { windowMs?: number; minIntervalMs?: number } = {},
): CoalescedInvalidator {
  const windowMs = opts.windowMs ?? 1000;
  const minIntervalMs = opts.minIntervalMs ?? 5000;
  const pending = new Map<string, readonly unknown[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt: number | null = null;

  function runFlush() {
    timer = null;
    if (pending.size === 0) return;
    lastFlushAt = Date.now();
    const keys = Array.from(pending.values());
    pending.clear();
    flush(keys);
  }

  return {
    request(key) {
      pending.set(JSON.stringify(key), key);
      if (timer !== null) return;
      const now = Date.now();
      const earliest = lastFlushAt === null ? now : lastFlushAt + minIntervalMs;
      timer = setTimeout(runFlush, Math.max(windowMs, earliest - now));
    },
    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
    },
  };
}
