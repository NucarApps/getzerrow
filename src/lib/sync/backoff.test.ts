// The queue's retry policy, as exact numbers.
//
// This used to accept a ±25% window around each expectation, which made
// the two backoff tables indistinguishable — their first entries are both
// 30s, so "uses the retryable table" and "uses the terminal table" passed
// for either. Math.random is stubbed instead, which makes jitter the
// identity (0.75 + 0.5*0.5 = 1.0) and every assertion an exact value; the
// jitter spread is then tested once, on its own.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BACKOFF_SECONDS,
  RETRYABLE_BACKOFF_SECONDS,
  computeBackoffSeconds,
  jitter,
  secondsUntilMidnightPT,
} from "./backoff";

type Opts = Parameters<typeof computeBackoffSeconds>[0];
const opts = (over: Partial<Opts> = {}): Opts => ({
  retryable: false,
  retryAfterSeconds: null,
  isQuotaExceeded: false,
  currentAttempt: 0,
  nextAttempt: 1,
  ...over,
});

beforeEach(() => {
  // 0.5 → jitter(x) === x, so every number below is the table value itself.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

describe("jitter", () => {
  it("spans ±25% of its input, floored", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(jitter(120)).toBe(90);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(jitter(120)).toBe(120);
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    expect(jitter(120)).toBe(149);
  });
});

describe("computeBackoffSeconds — precedence", () => {
  it("Retry-After wins over everything else", () => {
    expect(
      computeBackoffSeconds(
        opts({ retryAfterSeconds: 42, isQuotaExceeded: true, retryable: true, currentAttempt: 4 }),
      ),
    ).toBe(42);
  });

  it("a zero or negative Retry-After is ignored and the table decides", () => {
    expect(computeBackoffSeconds(opts({ retryAfterSeconds: 0, nextAttempt: 1 }))).toBe(30);
    expect(computeBackoffSeconds(opts({ retryAfterSeconds: -5, nextAttempt: 1 }))).toBe(30);
  });

  it("quotaExceeded outranks the tables", () => {
    vi.useFakeTimers();
    // 00:30 PT — 23.5h to midnight, so the 6h cap is what applies.
    vi.setSystemTime(new Date("2026-09-02T07:30:00.000Z"));
    expect(computeBackoffSeconds(opts({ isQuotaExceeded: true, currentAttempt: 4 }))).toBe(
      6 * 3600,
    );
    vi.useRealTimers();
  });
});

// The two tables share their first entry (30s), so index 0 proves nothing.
// Index 1 is where they diverge: 90s retryable vs 120s terminal.
describe("computeBackoffSeconds — which table, at an index that distinguishes them", () => {
  it("a transient failure uses RETRYABLE_BACKOFF_SECONDS, indexed by currentAttempt", () => {
    expect(computeBackoffSeconds(opts({ retryable: true, currentAttempt: 1 }))).toBe(90);
    expect(RETRYABLE_BACKOFF_SECONDS[1]).toBe(90);
  });

  it("a terminal failure uses BACKOFF_SECONDS, indexed by nextAttempt - 1", () => {
    expect(computeBackoffSeconds(opts({ retryable: false, nextAttempt: 2 }))).toBe(120);
    expect(BACKOFF_SECONDS[1]).toBe(120);
  });

  it("walks each table entry in order", () => {
    expect(
      RETRYABLE_BACKOFF_SECONDS.map((_, i) =>
        computeBackoffSeconds(opts({ retryable: true, currentAttempt: i })),
      ),
    ).toEqual(RETRYABLE_BACKOFF_SECONDS);
    expect(
      BACKOFF_SECONDS.map((_, i) =>
        computeBackoffSeconds(opts({ retryable: false, nextAttempt: i + 1 })),
      ),
    ).toEqual(BACKOFF_SECONDS);
  });

  it("clamps to the last entry once the attempts run past the table", () => {
    expect(computeBackoffSeconds(opts({ retryable: true, currentAttempt: 99 }))).toBe(3600);
    expect(computeBackoffSeconds(opts({ retryable: false, nextAttempt: 99 }))).toBe(7200);
  });

  // run-jobs writes `Date.now() + seconds * 1000` into next_run_at, so an
  // index that falls off the BOTTOM of the table must not reach the caller
  // as a NaN — that becomes an invalid timestamp on the queue row, and the
  // job never runs again.
  it("clamps to the first entry when the attempt counter is below the table", () => {
    expect(computeBackoffSeconds(opts({ retryable: false, nextAttempt: 0 }))).toBe(30);
    expect(computeBackoffSeconds(opts({ retryable: true, currentAttempt: 0 }))).toBe(30);
  });

  it("clamps to the first entry for a negative attempt counter on either table", () => {
    expect(computeBackoffSeconds(opts({ retryable: false, nextAttempt: -7 }))).toBe(30);
    expect(computeBackoffSeconds(opts({ retryable: true, currentAttempt: -7 }))).toBe(30);
  });

  it("returns a usable interval for every attempt counter, never NaN", () => {
    for (const n of [-100, -1, 0, 1, 2, 5, 99]) {
      const terminal = computeBackoffSeconds(opts({ retryable: false, nextAttempt: n }));
      const transient = computeBackoffSeconds(opts({ retryable: true, currentAttempt: n }));
      expect(Number.isFinite(terminal), `terminal backoff for nextAttempt ${n}`).toBe(true);
      expect(Number.isFinite(transient), `transient backoff for currentAttempt ${n}`).toBe(true);
      expect(terminal).toBeGreaterThan(0);
      expect(transient).toBeGreaterThan(0);
    }
  });
});

describe("secondsUntilMidnightPT", () => {
  afterEach(() => vi.useRealTimers());

  const at = (iso: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
    return secondsUntilMidnightPT();
  };

  it("counts down from the current Pacific wall clock", () => {
    // 2026-09-02 00:30 PDT (UTC-7) → 23h30m left.
    expect(at("2026-09-02T07:30:00.000Z")).toBe(23 * 3600 + 30 * 60);
  });

  it("is DST-aware: the same Pacific wall clock gives the same answer in PDT and PST", () => {
    // 12:00 PDT is 19:00Z; 12:00 PST is 20:00Z. Both must return 12h.
    expect(at("2026-09-02T19:00:00.000Z")).toBe(12 * 3600);
    expect(at("2026-01-15T20:00:00.000Z")).toBe(12 * 3600);
  });

  it("never returns less than a minute, so a job right before midnight still backs off", () => {
    // 23:59:30 PDT.
    expect(at("2026-09-03T06:59:30.000Z")).toBe(60);
  });

  it("returns the full day at exactly midnight Pacific", () => {
    expect(at("2026-09-02T07:00:00.000Z")).toBe(86400);
  });
});
