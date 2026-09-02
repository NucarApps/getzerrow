// Geometry for the card-analytics activity sparkline.
//
// The bars are the only place the daily counts are turned into something the
// reader interprets, so a wrong scale is a wrong story about the card. The
// arithmetic lives here, away from the SVG, so the shapes that break naive
// bar charts — an empty range, a single day, a flat series, one huge spike —
// can be checked directly.

export type SparklineDay = {
  day: string;
  views: number;
  clicks: number;
  downloads: number;
  shares: number;
};

export type SparklineBar = {
  /** The ISO day this bar stands for, used as the React key and the tooltip. */
  day: string;
  /** The day's combined event count. */
  total: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Sparkline = {
  /** viewBox dimensions; the SVG scales to its container. */
  width: number;
  height: number;
  /** The value the tallest bar represents. */
  max: number;
  bars: SparklineBar[];
  firstDay: string;
  lastDay: string;
};

/** viewBox width. Arbitrary — the SVG is drawn with preserveAspectRatio none. */
export const SPARKLINE_WIDTH = 600;
/** viewBox height. */
export const SPARKLINE_HEIGHT = 80;
/** Headroom kept above the tallest bar so it does not touch the top edge. */
export const SPARKLINE_HEADROOM = 8;
/** Horizontal gap between neighbouring bars, split either side. */
export const SPARKLINE_GAP = 2;

export function totalFor(d: SparklineDay): number {
  return d.views + d.clicks + d.downloads + d.shares;
}

/**
 * Lay out one bar per day. Returns null for an empty range — there is no
 * chart to draw and the caller renders nothing at all.
 *
 * The scale floor of 1 matters: a range where nothing happened would
 * otherwise divide by zero and every bar would be NaN-tall.
 */
export function buildSparkline(
  daily: SparklineDay[],
  opts: { width?: number; height?: number } = {},
): Sparkline | null {
  if (!daily.length) return null;

  const width = opts.width ?? SPARKLINE_WIDTH;
  const height = opts.height ?? SPARKLINE_HEIGHT;
  const max = Math.max(1, ...daily.map(totalFor));
  const step = width / daily.length;

  const bars = daily.map((d, i) => {
    const total = totalFor(d);
    const barHeight = (total / max) * (height - SPARKLINE_HEADROOM);
    return {
      day: d.day,
      total,
      x: i * step + SPARKLINE_GAP / 2,
      y: height - barHeight,
      width: Math.max(1, step - SPARKLINE_GAP),
      height: barHeight,
    };
  });

  return {
    width,
    height,
    max,
    bars,
    firstDay: daily[0]!.day,
    lastDay: daily[daily.length - 1]!.day,
  };
}
