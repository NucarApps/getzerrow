import { describe, it, expect, vi, afterEach } from "vitest";
import { formatRelativeTime, truncate } from "./format";

const NOW = Date.parse("2026-07-25T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ahead = (ms: number) => new Date(NOW + ms).toISOString();

function at(now: number, fn: () => void) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    fn();
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => vi.useRealTimers());

describe("formatRelativeTime", () => {
  it("walks the second/minute/hour/day ladder", () => {
    at(NOW, () => {
      expect(formatRelativeTime(ago(45_000))).toBe("45s ago");
      expect(formatRelativeTime(ago(12 * 60_000))).toBe("12m ago");
      expect(formatRelativeTime(ago(3 * 3600_000))).toBe("3h ago");
      expect(formatRelativeTime(ago(2 * 86_400_000))).toBe("2d ago");
    });
  });

  it("floors rather than rounds, so 1h59m is still 1h", () => {
    at(NOW, () => {
      expect(formatRelativeTime(ago(119 * 60_000))).toBe("1h ago");
      expect(formatRelativeTime(ago(59_900))).toBe("59s ago");
    });
  });

  // Two of the four copies mishandled this: one rendered a negative
  // "-5s ago", the other clamped it to "0s ago".
  it("renders a future timestamp as 'in X', never negative or clamped", () => {
    at(NOW, () => {
      expect(formatRelativeTime(ahead(5_000))).toBe("in 5s");
      expect(formatRelativeTime(ahead(90_000))).toBe("in 1m");
      expect(formatRelativeTime(ahead(5 * 3600_000))).toBe("in 5h");
      expect(formatRelativeTime(ahead(3 * 86_400_000))).toBe("in 3d");
    });
  });

  it("uses the em-dash fallback for nullish input by default", () => {
    expect(formatRelativeTime(null)).toBe("—");
    expect(formatRelativeTime(undefined)).toBe("—");
    expect(formatRelativeTime("")).toBe("—");
  });

  it("honors a caller's fallback (the health card says 'never')", () => {
    expect(formatRelativeTime(null, { fallback: "never" })).toBe("never");
  });

  it("falls back rather than printing NaN for an unparseable date", () => {
    expect(formatRelativeTime("not-a-date")).toBe("—");
    expect(formatRelativeTime("not-a-date", { fallback: "never" })).toBe("never");
  });
});

describe("truncate", () => {
  it("leaves a short string alone", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("clips with an ellipsis", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });

  it("uses the fallback for nullish input", () => {
    expect(truncate(null, 5)).toBe("—");
    expect(truncate(undefined, 5, "n/a")).toBe("n/a");
  });
});
