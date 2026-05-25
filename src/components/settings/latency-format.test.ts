// fmtLatency + latencyTone are pure presentation helpers for the push
// latency tile. The SLO thresholds (1s/3s) are a contract with operators —
// these tests pin them so they can't drift silently.
import { describe, it, expect } from "vitest";
import { fmtLatency, latencyTone } from "./latency-format";

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
