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
