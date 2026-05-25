// fmtLatency + latencyTone + computeStaleness are pure presentation
// helpers for the push latency tile. The SLO thresholds (1s/3s for
// latency, 1h/6h for staleness) are a contract with operators — these
// tests pin them so they can't drift silently.
import { describe, it, expect } from "vitest";
import { fmtLatency, latencyTone, computeStaleness } from "./latency-format";

describe("fmtLatency", () => {
  it("renders sub-second values in milliseconds", () => {
    expect(fmtLatency(0)).toBe("0ms");
    expect(fmtLatency(120)).toBe("120ms");
    expect(fmtLatency(999)).toBe("999ms");
  });

  it("renders 1-10s values with one decimal place", () => {
    expect(fmtLatency(1000)).toBe("1.0s");
    expect(fmtLatency(1500)).toBe("1.5s");
    expect(fmtLatency(9999)).toBe("10.0s"); // rounded
  });

  it("renders 10-60s values as whole seconds", () => {
    expect(fmtLatency(10_000)).toBe("10s");
    expect(fmtLatency(45_678)).toBe("46s");
    expect(fmtLatency(59_999)).toBe("60s");
  });

  it("renders 60s+ values as whole minutes", () => {
    expect(fmtLatency(60_000)).toBe("1m");
    expect(fmtLatency(125_000)).toBe("2m");
    expect(fmtLatency(3_600_000)).toBe("60m");
  });

  it("renders empty / non-finite values as a placeholder", () => {
    expect(fmtLatency(null)).toBe("—");
    expect(fmtLatency(undefined)).toBe("—");
    expect(fmtLatency(NaN)).toBe("—");
    expect(fmtLatency(Infinity)).toBe("—");
  });
});

describe("latencyTone", () => {
  it("returns 'good' for sub-1s latencies (operator SLO target)", () => {
    expect(latencyTone(0)).toBe("good");
    expect(latencyTone(500)).toBe("good");
    expect(latencyTone(999)).toBe("good");
  });

  it("returns 'warn' for 1-3s latencies", () => {
    expect(latencyTone(1000)).toBe("warn");
    expect(latencyTone(2500)).toBe("warn");
    expect(latencyTone(2999)).toBe("warn");
  });

  it("returns 'bad' for anything ≥ 3s", () => {
    expect(latencyTone(3000)).toBe("bad");
    expect(latencyTone(10_000)).toBe("bad");
    expect(latencyTone(3_600_000)).toBe("bad");
  });

  it("returns 'muted' for missing data (no samples)", () => {
    expect(latencyTone(null)).toBe("muted");
    expect(latencyTone(undefined)).toBe("muted");
    expect(latencyTone(NaN)).toBe("muted");
  });
});

describe("computeStaleness", () => {
  const NOW = new Date("2026-05-25T12:00:00Z");

  it("returns 'none' when there's no last push AND no samples (fresh deploy)", () => {
    expect(computeStaleness(null, 0, NOW)).toEqual({ kind: "none" });
  });

  it("returns 'no_recent_push' when there's no last push but stored samples", () => {
    // The samples are stored but the lookback window has no fresh activity.
    expect(computeStaleness(null, 12, NOW)).toEqual({ kind: "no_recent_push" });
  });

  it("returns 'live' for pushes under 1h ago", () => {
    const tenMinAgo = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    const r = computeStaleness(tenMinAgo, 5, NOW);
    expect(r.kind).toBe("live");
    if (r.kind === "live") expect(r.ageMinutes).toBe(10);
  });

  it("returns 'live' with <1m when push was 30 seconds ago", () => {
    const thirtySecAgo = new Date(NOW.getTime() - 30_000).toISOString();
    const r = computeStaleness(thirtySecAgo, 1, NOW);
    expect(r.kind).toBe("live");
    if (r.kind === "live") expect(r.ageMinutes).toBe(0);
  });

  it("returns 'live' for clock-skew (future timestamps don't crash)", () => {
    const futureLol = new Date(NOW.getTime() + 5 * 60_000).toISOString();
    const r = computeStaleness(futureLol, 1, NOW);
    expect(r.kind).toBe("live");
    if (r.kind === "live") expect(r.ageMinutes).toBe(0);
  });

  it("returns 'stale_amber' between 1h and 6h", () => {
    const oneHourAgo = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    expect(computeStaleness(oneHourAgo, 100, NOW).kind).toBe("stale_amber");

    const fiveHrAgo = new Date(NOW.getTime() - 5 * 60 * 60_000).toISOString();
    const r = computeStaleness(fiveHrAgo, 100, NOW);
    expect(r.kind).toBe("stale_amber");
    if (r.kind === "stale_amber") expect(Math.round(r.ageHours)).toBe(5);
  });

  it("returns 'stale_red' at 6h and beyond", () => {
    const sixHrAgo = new Date(NOW.getTime() - 6 * 60 * 60_000).toISOString();
    expect(computeStaleness(sixHrAgo, 100, NOW).kind).toBe("stale_red");

    const twoDaysAgo = new Date(NOW.getTime() - 48 * 60 * 60_000).toISOString();
    const r = computeStaleness(twoDaysAgo, 100, NOW);
    expect(r.kind).toBe("stale_red");
    if (r.kind === "stale_red") expect(Math.round(r.ageHours)).toBe(48);
  });

  it("accepts Date objects in addition to ISO strings", () => {
    const tenMinAgo = new Date(NOW.getTime() - 10 * 60_000);
    expect(computeStaleness(tenMinAgo, 5, NOW).kind).toBe("live");
  });
});
