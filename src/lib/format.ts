/**
 * Shared date/time formatting. Centralizes the several copy-pasted
 * `formatWhen()` helpers so date output is consistent across the app.
 *
 * Locale policy: pass `undefined` locale to `toLocaleString` so the user's
 * runtime locale is respected everywhere. Callers supply a `fallback` for the
 * null/empty case (kept configurable because "Never" vs "No start time" vs "—"
 * carry different meaning at different call-sites).
 */

const DEFAULT_FALLBACK = "—"; // em dash

/**
 * Compact relative time: "45s ago", "12m ago", "3h ago", "2d ago", and
 * "in 5m" for timestamps in the future.
 *
 * Four settings/activity screens had their own copy of this ladder, differing
 * only in fallback text and in how badly they handled a future timestamp — one
 * rendered a negative "-5s ago", another clamped it to "0s ago". Both now read
 * "in 5s".
 *
 * Uses floor, not round, so 1h59m reads "1h ago" rather than "2h ago".
 *
 * Deliberately NOT used by folder-history-panel or FolderEditor: those speak a
 * different vocabulary ("just now" with a date fallback past a week; "today"
 * and months) and are different formats, not copies of this one.
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  opts: { fallback?: string } = {},
): string {
  const { fallback = DEFAULT_FALLBACK } = opts;
  if (!iso) return fallback;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return fallback;

  const diffMs = Date.now() - t;
  const future = diffMs < 0;
  const s = Math.floor(Math.abs(diffMs) / 1000);
  const unit =
    s < 60
      ? `${s}s`
      : s < 3600
        ? `${Math.floor(s / 60)}m`
        : s < 86_400
          ? `${Math.floor(s / 3600)}h`
          : `${Math.floor(s / 86_400)}d`;
  return future ? `in ${unit}` : `${unit} ago`;
}

/**
 * Clip a string to `max` characters, replacing the tail with an ellipsis.
 * Returns `fallback` for null/empty input.
 */
export function truncate(
  s: string | null | undefined,
  max: number,
  fallback: string = DEFAULT_FALLBACK,
): string {
  if (!s) return fallback;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Full locale date + time (e.g. "1/23/2026, 4:05 PM"). */
export function formatDateTime(
  iso: string | null | undefined,
  fallback: string = DEFAULT_FALLBACK,
): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/**
 * Compact calendar-event time: month/day + time, optionally prefixed with the
 * weekday (e.g. "Fri, Jan 23, 4:05 PM" or "Jan 23, 4:05 PM").
 */
export function formatEventTime(
  iso: string | null | undefined,
  opts: { fallback?: string; weekday?: boolean } = {},
): string {
  const { fallback = DEFAULT_FALLBACK, weekday = false } = opts;
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    ...(weekday ? { weekday: "short" as const } : {}),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Short calendar date, no time (e.g. "Jan 23, 2026"). */
export function formatShortDate(
  iso: string | null | undefined,
  fallback: string = DEFAULT_FALLBACK,
): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Short date + zero-padded time (e.g. "Jan 23, 04:05 PM").
 *
 * Differs from `formatEventTime` in two ways that are deliberate rather than
 * accidental: the hour is zero-padded (dense admin tables line up) and an
 * unparseable timestamp reads as the fallback instead of the raw ISO string.
 */
export function formatShortDateTime(
  iso: string | null | undefined,
  fallback: string = DEFAULT_FALLBACK,
): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Compact message-row timestamp: HH:MM for today, the weekday name within a
 * week, then "Mon D". Returns "" (not a dash) for a missing or unparseable
 * timestamp because it renders inside a dense list row where a placeholder
 * would be noise.
 *
 * `now` is a parameter so the today/this-week boundaries are testable.
 */
export function shortRowTime(iso: string | null | undefined, now: Date): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Start-of-day (local) epoch millis for a date. */
function startOfDay(x: Date): number {
  return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
}

/**
 * Day-group header for a message list: Today / Yesterday / This week /
 * This month / Earlier. Compares calendar days, not elapsed hours, so a
 * message from 23:59 last night is "Yesterday" rather than "Today".
 *
 * A future timestamp groups under "Today" (diffDays <= 0).
 */
export function dayGroupLabel(iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const diffDays = Math.floor((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "This week";
  if (diffDays < 31) return "This month";
  return "Earlier";
}

/**
 * Fractional hours between `iso` and `now`; null when there is no usable
 * timestamp. Negative for a future timestamp — callers compare it against a
 * staleness threshold, and a future stamp is by definition not stale.
 */
export function hoursSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 36e5;
}

/**
 * A duration in seconds as the largest single unit: "45s", "7m", "2.5h".
 * Hours keep one decimal; minutes and seconds are whole.
 */
export function formatDuration(
  seconds: number | null | undefined,
  fallback: string = DEFAULT_FALLBACK,
): string {
  if (seconds === null || seconds === undefined) return fallback;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 360) / 10}h`;
}

/** A latency in milliseconds: "850ms" under a second, else "1.4s". */
export function formatMs(
  ms: number | null | undefined,
  fallback: string = DEFAULT_FALLBACK,
): string {
  if (ms === null || ms === undefined) return fallback;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Stopwatch readout for a live recording: zero-padded MM:SS. Minutes are not
 * carried into hours — a 90-minute meeting reads "90:00", which is what the
 * recorder UI wants.
 */
export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}
