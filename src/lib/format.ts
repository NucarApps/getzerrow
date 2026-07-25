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
