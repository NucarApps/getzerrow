import { describe, it, expect, vi, afterEach } from "vitest";
import {
  dayGroupLabel,
  formatDateTime,
  formatDuration,
  formatElapsed,
  formatEventTime,
  formatMs,
  formatRelativeTime,
  formatShortDate,
  formatShortDateTime,
  hoursSince,
  shortRowTime,
  truncate,
} from "./format";

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

// The suite runs with TZ=UTC (vitest.config.ts) and node's default en-US
// locale, so these literals are stable. `now` is a parameter on every helper
// that needs one, which is why none of the blocks below touch fake timers.
const on = (iso: string) => new Date(iso);

describe("shortRowTime", () => {
  const NOW_ROW = on("2026-07-25T15:00:00Z"); // a Saturday

  it("shows a 24h clock for a timestamp on today's calendar date", () => {
    expect(shortRowTime("2026-07-25T09:05:00Z", NOW_ROW)).toBe("09:05");
    expect(shortRowTime("2026-07-25T23:59:00Z", NOW_ROW)).toBe("23:59");
  });

  it("renders midnight as 00:00, not 24:00", () => {
    expect(shortRowTime("2026-07-25T00:00:00Z", NOW_ROW)).toBe("00:00");
  });

  it("crosses to the weekday name the moment the calendar date changes", () => {
    // One minute apart, either side of midnight: same elapsed hour, different
    // rendering, because the today test compares calendar dates.
    const justAfterMidnight = on("2026-07-25T00:01:00Z");
    expect(shortRowTime("2026-07-25T00:00:00Z", justAfterMidnight)).toBe("00:00");
    expect(shortRowTime("2026-07-24T23:59:00Z", justAfterMidnight)).toBe("Fri");
  });

  it("names the weekday inside the trailing seven days", () => {
    expect(shortRowTime("2026-07-24T09:00:00Z", NOW_ROW)).toBe("Fri");
    expect(shortRowTime("2026-07-19T09:00:00Z", NOW_ROW)).toBe("Sun");
  });

  it("switches to a month/day date at exactly seven elapsed days", () => {
    expect(shortRowTime("2026-07-18T15:00:01Z", NOW_ROW)).toBe("Sat");
    expect(shortRowTime("2026-07-18T15:00:00Z", NOW_ROW)).toBe("Jul 18");
  });

  it("keeps a month/day date across a year boundary", () => {
    expect(shortRowTime("2025-12-31T09:00:00Z", NOW_ROW)).toBe("Dec 31");
  });

  // A clock-skewed row (server timestamp ahead of the browser) has a negative
  // elapsed age, which passes the `< 7` test and reads as a weekday.
  it("renders a future timestamp as a weekday rather than a date", () => {
    expect(shortRowTime("2026-07-26T09:00:00Z", NOW_ROW)).toBe("Sun");
  });

  it("renders nothing at all for a missing or unparseable timestamp", () => {
    expect(shortRowTime(null, NOW_ROW)).toBe("");
    expect(shortRowTime(undefined, NOW_ROW)).toBe("");
    expect(shortRowTime("", NOW_ROW)).toBe("");
    expect(shortRowTime("not-a-date", NOW_ROW)).toBe("");
  });
});

describe("dayGroupLabel", () => {
  const NOW_GROUP = on("2026-07-25T15:00:00Z");

  it.each([
    ["2026-07-25T00:00:00Z", "Today"],
    ["2026-07-25T23:59:59Z", "Today"],
    ["2026-07-24T23:59:59Z", "Yesterday"],
    ["2026-07-24T00:00:00Z", "Yesterday"],
    ["2026-07-23T12:00:00Z", "This week"],
    ["2026-07-19T12:00:00Z", "This week"],
    ["2026-07-18T12:00:00Z", "This month"],
    ["2026-06-25T12:00:00Z", "This month"],
    ["2026-06-24T12:00:00Z", "Earlier"],
    ["2025-07-25T12:00:00Z", "Earlier"],
  ])("groups %s as %s", (iso, label) => {
    expect(dayGroupLabel(iso, NOW_GROUP)).toBe(label);
  });

  it("compares calendar days, so last night at 23:59 is Yesterday", () => {
    // 62 minutes elapsed, but a different calendar day.
    const justAfterMidnight = on("2026-07-25T01:01:00Z");
    expect(dayGroupLabel("2026-07-24T23:59:00Z", justAfterMidnight)).toBe("Yesterday");
  });

  it("crosses a month boundary without confusing the day arithmetic", () => {
    const marchFirst = on("2026-03-01T09:00:00Z");
    expect(dayGroupLabel("2026-02-28T09:00:00Z", marchFirst)).toBe("Yesterday");
    expect(dayGroupLabel("2026-02-23T09:00:00Z", marchFirst)).toBe("This week");
  });

  it("crosses a year boundary without confusing the day arithmetic", () => {
    const newYearsDay = on("2026-01-01T09:00:00Z");
    expect(dayGroupLabel("2025-12-31T22:00:00Z", newYearsDay)).toBe("Yesterday");
    expect(dayGroupLabel("2025-12-27T22:00:00Z", newYearsDay)).toBe("This week");
    expect(dayGroupLabel("2025-11-01T22:00:00Z", newYearsDay)).toBe("Earlier");
  });

  it("files a future timestamp under Today", () => {
    expect(dayGroupLabel("2026-08-01T09:00:00Z", NOW_GROUP)).toBe("Today");
  });

  it("returns null (no header at all) for a missing or unparseable timestamp", () => {
    expect(dayGroupLabel(null, NOW_GROUP)).toBeNull();
    expect(dayGroupLabel(undefined, NOW_GROUP)).toBeNull();
    expect(dayGroupLabel("nonsense", NOW_GROUP)).toBeNull();
  });
});

describe("hoursSince", () => {
  const NOW_HOURS = on("2026-07-25T12:00:00Z");

  it("measures fractional hours back to the timestamp", () => {
    expect(hoursSince("2026-07-25T09:00:00Z", NOW_HOURS)).toBe(3);
    expect(hoursSince("2026-07-25T11:30:00Z", NOW_HOURS)).toBe(0.5);
  });

  it("is exactly zero for the current instant", () => {
    expect(hoursSince("2026-07-25T12:00:00Z", NOW_HOURS)).toBe(0);
  });

  it("goes negative for a future timestamp so a staleness check cannot fire", () => {
    expect(hoursSince("2026-07-25T14:00:00Z", NOW_HOURS)).toBe(-2);
  });

  it("returns null rather than NaN when there is no usable timestamp", () => {
    expect(hoursSince(null, NOW_HOURS)).toBeNull();
    expect(hoursSince(undefined, NOW_HOURS)).toBeNull();
    expect(hoursSince("not-a-date", NOW_HOURS)).toBeNull();
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [45, "45s"],
    [59, "59s"],
    [60, "1m"],
    [90, "2m"],
    [3599, "60m"], // rounds within the minute band rather than promoting to 1h
    [3600, "1h"],
    [5400, "1.5h"],
    [86_400, "24h"],
  ])("renders %ds as %s", (seconds, out) => {
    expect(formatDuration(seconds)).toBe(out);
  });

  it("passes a negative interval straight through as seconds", () => {
    expect(formatDuration(-30)).toBe("-30s");
  });

  it("uses the fallback when there is no duration to show", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(null, "n/a")).toBe("n/a");
  });
});

describe("formatMs", () => {
  it.each([
    [0, "0ms"],
    [12.4, "12ms"],
    [999, "999ms"],
    [999.6, "1000ms"], // rounds inside the millisecond band, no promotion
    [1000, "1.0s"],
    [1449, "1.4s"],
    [12_000, "12.0s"],
  ])("renders %sms as %s", (ms, out) => {
    expect(formatMs(ms)).toBe(out);
  });

  it("uses the fallback when there is no latency to show", () => {
    expect(formatMs(null)).toBe("—");
    expect(formatMs(undefined, "n/a")).toBe("n/a");
  });
});

describe("formatElapsed", () => {
  it.each([
    [0, "00:00"],
    [5, "00:05"],
    [59, "00:59"],
    [60, "01:00"],
    [61, "01:01"],
    [599, "09:59"],
    [3600, "60:00"], // minutes are never carried into hours
    [5400, "90:00"],
  ])("renders %ds as %s", (seconds, out) => {
    expect(formatElapsed(seconds)).toBe(out);
  });

  it("truncates a fractional second rather than rounding up", () => {
    expect(formatElapsed(59.9)).toBe("00:59");
  });
});

describe("formatShortDate / formatShortDateTime", () => {
  it("renders a short calendar date without a time", () => {
    expect(formatShortDate("2026-01-23T16:05:00Z")).toBe("Jan 23, 2026");
  });

  it("zero-pads the hour so admin table columns line up", () => {
    expect(formatShortDateTime("2026-01-23T09:05:00Z")).toBe("Jan 23, 09:05 AM");
    expect(formatShortDateTime("2026-01-23T23:05:00Z")).toBe("Jan 23, 11:05 PM");
  });

  it("uses the fallback for nullish and unparseable input alike", () => {
    expect(formatShortDate(null)).toBe("—");
    expect(formatShortDate("not-a-date")).toBe("—");
    expect(formatShortDateTime(undefined)).toBe("—");
    expect(formatShortDateTime("not-a-date", "n/a")).toBe("n/a");
  });
});

describe("formatDateTime / formatEventTime", () => {
  it("renders a full locale date and time", () => {
    expect(formatDateTime("2026-01-23T16:05:00Z")).toBe("1/23/2026, 4:05:00 PM");
  });

  it("renders a compact event time, with the weekday only when asked", () => {
    expect(formatEventTime("2026-01-23T16:05:00Z")).toBe("Jan 23, 4:05 PM");
    expect(formatEventTime("2026-01-23T16:05:00Z", { weekday: true })).toBe("Fri, Jan 23, 4:05 PM");
  });

  it("uses the fallback for nullish input", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined, "Never")).toBe("Never");
    expect(formatEventTime(null)).toBe("—");
    expect(formatEventTime("", { fallback: "No start time" })).toBe("No start time");
  });
});

describe("unparseable-input handling across the formatters", () => {
  it("uses the default fallback rather than leaking the raw string into the UI", () => {
    expect(formatDateTime("not-a-date")).toBe("—");
    expect(formatEventTime("not-a-date")).toBe("—");
    expect(formatRelativeTime("not-a-date")).toBe("—");
    expect(formatShortDate("not-a-date")).toBe("—");
    expect(formatShortDateTime("not-a-date")).toBe("—");
  });

  it("honours the caller's own fallback on every formatter", () => {
    expect(formatDateTime("not-a-date", "n/a")).toBe("n/a");
    expect(formatEventTime("not-a-date", { fallback: "No start time" })).toBe("No start time");
    expect(formatRelativeTime("not-a-date", { fallback: "never" })).toBe("never");
    expect(formatShortDate("not-a-date", "n/a")).toBe("n/a");
    expect(formatShortDateTime("not-a-date", "n/a")).toBe("n/a");
  });

  it("treats a plausible-looking but invalid date the same as obvious garbage", () => {
    // "2026-02-30" parses to Invalid Date, and previously reached the UI verbatim.
    expect(formatDateTime("2026-02-30T99:99:99Z", "n/a")).toBe("n/a");
    expect(formatEventTime("2026-02-30T99:99:99Z", { fallback: "n/a" })).toBe("n/a");
  });
});
