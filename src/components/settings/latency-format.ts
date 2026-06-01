// Pure presentation helpers for the push-latency tile. Split into a .ts
// file so unit tests can import without dragging React / Supabase client /
// etc. through node.
//
// SLO contract (also documented on the tile itself):
//   p50 < 1s  → green
//   p50 < 3s  → amber
//   p50 ≥ 3s  → red
// Changing thresholds = breaking the operator dashboard, so the test suite
// pins these.

/** Compact human readout for a latency value (ms). Empty / non-finite
 * values render as an em-dash so the eye skips them. */
export function fmtLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export type LatencyTone = "good" | "warn" | "bad" | "muted";

/** Maps a latency value to one of the four UI tones. */
export function latencyTone(ms: number | null | undefined): LatencyTone {
  if (ms == null || !Number.isFinite(ms)) return "muted";
  if (ms < 1000) return "good";
  if (ms < 3000) return "warn";
  return "bad";
}

export const LATENCY_TONE_CLASS: Record<LatencyTone, string> = {
  good: "text-emerald-600",
  warn: "text-amber-600",
  bad: "text-destructive",
  muted: "text-muted-foreground",
};

export type StalenessState =
  | { kind: "none" }
  | { kind: "no_recent_push" }
  | { kind: "live"; ageMinutes: number }
  | { kind: "stale_amber"; ageHours: number }
  | { kind: "stale_red"; ageHours: number };

/** Map (lastPushAt, sampleCount) → operator staleness state. Used by the
 * latency tile's StalenessBadge — pure so the SLO bucket boundaries can
 * be unit-tested. Boundaries: <1h live, 1-6h amber, ≥6h red. */
export function computeStaleness(
  lastPushAt: string | Date | null,
  sampleCount: number,
  now: Date = new Date(),
): StalenessState {
  if (!lastPushAt) {
    return sampleCount > 0 ? { kind: "no_recent_push" } : { kind: "none" };
  }
  const ageMs = now.getTime() - new Date(lastPushAt).getTime();
  if (ageMs < 0) return { kind: "live", ageMinutes: 0 };
  const ageHours = ageMs / 3_600_000;
  if (ageHours >= 6) return { kind: "stale_red", ageHours };
  if (ageHours >= 1) return { kind: "stale_amber", ageHours };
  return { kind: "live", ageMinutes: Math.floor(ageMs / 60_000) };
}
