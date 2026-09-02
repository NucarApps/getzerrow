import { describe, expect, it } from "vitest";
import {
  buildSparkline,
  SPARKLINE_HEADROOM,
  SPARKLINE_HEIGHT,
  SPARKLINE_WIDTH,
  totalFor,
  type SparklineDay,
} from "./sparkline";

/** The full bar height, i.e. what a day equal to the maximum gets. */
const FULL = SPARKLINE_HEIGHT - SPARKLINE_HEADROOM;

function day(d: string, over: Partial<SparklineDay> = {}): SparklineDay {
  return { day: d, views: 0, clicks: 0, downloads: 0, shares: 0, ...over };
}

describe("totalFor", () => {
  it("adds every event kind, not just views", () => {
    expect(totalFor(day("2026-09-01", { views: 1, clicks: 2, downloads: 3, shares: 4 }))).toBe(10);
  });

  it("is zero for a day with no activity", () => {
    expect(totalFor(day("2026-09-01"))).toBe(0);
  });
});

describe("buildSparkline — degenerate ranges", () => {
  it("returns null for an empty series so the caller draws nothing", () => {
    expect(buildSparkline([])).toBeNull();
  });

  it("draws a single day as one full-width bar", () => {
    const chart = buildSparkline([day("2026-09-01", { views: 5 })]);
    expect(chart).toStrictEqual({
      width: SPARKLINE_WIDTH,
      height: SPARKLINE_HEIGHT,
      max: 5,
      firstDay: "2026-09-01",
      lastDay: "2026-09-01",
      bars: [
        {
          day: "2026-09-01",
          total: 5,
          x: 1,
          y: SPARKLINE_HEIGHT - FULL,
          width: SPARKLINE_WIDTH - 2,
          height: FULL,
        },
      ],
    });
  });

  it("floors the scale at one so a range with no activity is flat, not NaN", () => {
    const chart = buildSparkline([day("2026-09-01"), day("2026-09-02")]);
    expect(chart?.max).toBe(1);
    expect(chart?.bars.map((b) => b.height)).toStrictEqual([0, 0]);
    expect(chart?.bars.map((b) => b.y)).toStrictEqual([SPARKLINE_HEIGHT, SPARKLINE_HEIGHT]);
  });

  it("draws every bar at full height when all days are equal", () => {
    const chart = buildSparkline([
      day("2026-09-01", { views: 4 }),
      day("2026-09-02", { clicks: 4 }),
      day("2026-09-03", { shares: 2, downloads: 2 }),
    ]);
    expect(chart?.max).toBe(4);
    expect(chart?.bars.map((b) => b.height)).toStrictEqual([FULL, FULL, FULL]);
  });

  it("scales the rest of the series against a single huge outlier", () => {
    const chart = buildSparkline([
      day("2026-09-01", { views: 1 }),
      day("2026-09-02", { views: 1000 }),
      day("2026-09-03", { views: 1 }),
    ]);
    expect(chart?.max).toBe(1000);
    expect(chart!.bars.map((b) => b.height)).toHaveLength(3);
    expect(chart!.bars[1]!.height).toBe(FULL);
    // The quiet days are a thousandth of the spike, not clamped to a
    // readable minimum: the chart shows the real shape of the range.
    expect(chart!.bars[0]!.height).toBeCloseTo(FULL / 1000, 10);
    expect(chart!.bars[2]!.height).toBeCloseTo(FULL / 1000, 10);
  });

  it("keeps a non-zero day visible in the viewBox even next to an outlier", () => {
    // The bar is sub-pixel tall at this scale, but it is still positioned
    // inside the chart rather than clipped away.
    const chart = buildSparkline([
      day("2026-09-01", { views: 1 }),
      day("2026-09-02", { views: 100_000 }),
    ]);
    expect(chart!.bars[0]!.height).toBeGreaterThan(0);
    expect(chart!.bars[0]!.y).toBeLessThan(SPARKLINE_HEIGHT);
  });
});

describe("buildSparkline — layout", () => {
  const week = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"].map((d, i) =>
    day(d, { views: i + 1 }),
  );

  it("spaces the bars evenly across the full width", () => {
    const chart = buildSparkline(week)!;
    const step = SPARKLINE_WIDTH / week.length;
    expect(chart.bars.map((b) => b.x)).toStrictEqual([1, step + 1, 2 * step + 1, 3 * step + 1]);
  });

  it("leaves a gap between neighbouring bars", () => {
    const chart = buildSparkline(week)!;
    const [first, second] = chart.bars;
    expect(first!.x + first!.width).toBeLessThan(second!.x);
  });

  it("never lets a bar collapse below one unit wide, however long the range", () => {
    const long = Array.from({ length: SPARKLINE_WIDTH * 2 }, (_, i) => day(`d-${i}`, { views: 1 }));
    const chart = buildSparkline(long)!;
    expect(chart.bars.every((b) => b.width >= 1)).toBe(true);
  });

  it("grows bars downward from the baseline, so y plus height is the baseline", () => {
    const chart = buildSparkline(week)!;
    for (const bar of chart.bars) {
      expect(bar.y + bar.height).toBeCloseTo(SPARKLINE_HEIGHT, 10);
    }
  });

  it("keeps the tallest bar inside the headroom", () => {
    const chart = buildSparkline(week)!;
    expect(Math.min(...chart.bars.map((b) => b.y))).toBe(SPARKLINE_HEADROOM);
  });

  it("carries each day's own label and total onto its bar", () => {
    const chart = buildSparkline(week)!;
    expect(chart.bars.map((b) => [b.day, b.total])).toStrictEqual([
      ["2026-09-01", 1],
      ["2026-09-02", 2],
      ["2026-09-03", 3],
      ["2026-09-04", 4],
    ]);
  });

  it("reports the first and last day of the range for the axis labels", () => {
    const chart = buildSparkline(week)!;
    expect([chart.firstDay, chart.lastDay]).toStrictEqual(["2026-09-01", "2026-09-04"]);
  });

  it("takes the range's own order rather than sorting it", () => {
    // The server already returns the days sorted; re-sorting here would hide
    // a regression there instead of showing it.
    const chart = buildSparkline([
      day("2026-09-05", { views: 1 }),
      day("2026-09-01", { views: 1 }),
    ])!;
    expect([chart.firstDay, chart.lastDay]).toStrictEqual(["2026-09-05", "2026-09-01"]);
  });

  it("honours a caller-supplied viewBox", () => {
    const chart = buildSparkline([day("2026-09-01", { views: 1 })], { width: 100, height: 20 })!;
    expect([chart.width, chart.height]).toStrictEqual([100, 20]);
    expect(chart.bars[0]!.height).toBe(20 - SPARKLINE_HEADROOM);
    expect(chart.bars[0]!.width).toBe(98);
  });
});
