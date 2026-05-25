// Unit tests for backoff policy + per-account lock. These cover the two
// reliability fundamentals (#11 quota-aware backoff, #6 per-account lock)
// without needing a Supabase connection — both helpers are pure logic.
import { describe, it, expect, vi, afterEach } from "vitest";
import { computeBackoffSeconds, withAccountLock } from "./sync.server";

describe("computeBackoffSeconds", () => {
  it("honors Retry-After when present", () => {
    const s = computeBackoffSeconds({
      retryable: true,
      retryAfterSeconds: 42,
      isQuotaExceeded: false,
      currentAttempt: 0,
      nextAttempt: 0,
    });
    // jitter is ±25% so allow a window.
    expect(s).toBeGreaterThanOrEqual(Math.floor(42 * 0.75));
    expect(s).toBeLessThanOrEqual(Math.ceil(42 * 1.25));
  });

  it("waits a long time on quotaExceeded (until midnight PT)", () => {
    const s = computeBackoffSeconds({
      retryable: true,
      retryAfterSeconds: null,
      isQuotaExceeded: true,
      currentAttempt: 0,
      nextAttempt: 0,
    });
    // Minimum 60s (the floor in secondsUntilMidnightPT), max 6h.
    expect(s).toBeGreaterThanOrEqual(60);
    expect(s).toBeLessThanOrEqual(6 * 3600);
  });

  it("uses retryable backoff table for transient 5xx", () => {
    // First retryable attempt → index 0 → 30s ± jitter.
    const s = computeBackoffSeconds({
      retryable: true,
      retryAfterSeconds: null,
      isQuotaExceeded: false,
      currentAttempt: 0,
      nextAttempt: 0,
    });
    expect(s).toBeGreaterThanOrEqual(Math.floor(30 * 0.75));
    expect(s).toBeLessThanOrEqual(Math.ceil(30 * 1.25));
  });

  it("uses terminal backoff table for non-retryable errors", () => {
    // First terminal attempt → nextAttempt 1 → index 0 → 30s ± jitter.
    const s = computeBackoffSeconds({
      retryable: false,
      retryAfterSeconds: null,
      isQuotaExceeded: false,
      currentAttempt: 0,
      nextAttempt: 1,
    });
    expect(s).toBeGreaterThanOrEqual(Math.floor(30 * 0.75));
    expect(s).toBeLessThanOrEqual(Math.ceil(30 * 1.25));
  });

  it("caps backoff at the last table entry on repeated failures", () => {
    const s = computeBackoffSeconds({
      retryable: false,
      retryAfterSeconds: null,
      isQuotaExceeded: false,
      currentAttempt: 99,
      nextAttempt: 99,
    });
    // BACKOFF_SECONDS last entry is 7200s.
    expect(s).toBeGreaterThanOrEqual(Math.floor(7200 * 0.75));
    expect(s).toBeLessThanOrEqual(Math.ceil(7200 * 1.25));
  });
});

describe("withAccountLock", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces overlapping calls into one execution per account", async () => {
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return Math.random();
    });

    const [a, b, c] = await Promise.all([
      withAccountLock("acc-1", fn),
      withAccountLock("acc-1", fn),
      withAccountLock("acc-1", fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("does NOT block calls for different accounts", async () => {
    const fn1 = vi.fn(async () => "a");
    const fn2 = vi.fn(async () => "b");
    const [a, b] = await Promise.all([
      withAccountLock("acc-a", fn1),
      withAccountLock("acc-b", fn2),
    ]);
    expect(a).toBe("a");
    expect(b).toBe("b");
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("releases the lock on rejection so the next caller proceeds", async () => {
    const ok = await withAccountLock("acc-2", async () => {
      throw new Error("boom");
    }).catch((e: Error) => e.message);
    expect(ok).toBe("boom");

    const next = await withAccountLock("acc-2", async () => "next");
    expect(next).toBe("next");
  });
});
