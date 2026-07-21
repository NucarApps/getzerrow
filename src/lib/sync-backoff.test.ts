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
    // Base is min(secondsUntilMidnightPT, 6h) with ±25% jitter applied, so the
    // floor is 60*0.75 and the ceiling is 6h*1.25 (matches the jitter window
    // used by the other assertions in this file).
    expect(s).toBeGreaterThanOrEqual(Math.floor(60 * 0.75));
    expect(s).toBeLessThanOrEqual(Math.ceil(6 * 3600 * 1.25));
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

  it("coalesces overlapping callers onto the in-flight run plus one follow-up", async () => {
    // The follow-up exists so an event that arrived AFTER the in-flight run
    // read its history cursor still gets a fresh pass (instead of being
    // handed the in-flight run's stale result). N overlapping callers
    // therefore trigger at most 2 executions, never N.
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return calls;
    });

    const [a, b, c] = await Promise.all([
      withAccountLock("acc-1", fn),
      withAccountLock("acc-1", fn),
      withAccountLock("acc-1", fn),
    ]);

    // Caller 1 owns run #1; callers 2 and 3 coalesce onto the single
    // follow-up run #2.
    expect(fn).toHaveBeenCalledTimes(2);
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(b).toBe(c);
  });

  it("runs a fresh pass for a caller that arrives after the lock cleared", async () => {
    const fn = vi.fn(async () => "x");
    await withAccountLock("acc-seq", fn);
    await withAccountLock("acc-seq", fn);
    expect(fn).toHaveBeenCalledTimes(2);
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
