import { describe, it, expect } from "vitest";
import { autoDetectRect, centeredFallbackRect, type PixelBuffer } from "./card-detect";

/**
 * Build an RGBA buffer of a solid `bg` field, optionally with an opaque
 * rectangle of `fg` painted into it. Coordinates are inclusive-exclusive.
 */
function buffer(
  width: number,
  height: number,
  opts: { bg?: number; fg?: number; rect?: { x: number; y: number; w: number; h: number } } = {},
): PixelBuffer {
  const { bg = 240, fg = 20, rect } = opts;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside =
        rect !== undefined &&
        x >= rect.x &&
        x < rect.x + rect.w &&
        y >= rect.y &&
        y < rect.y + rect.h;
      const v = inside ? fg : bg;
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

describe("centeredFallbackRect", () => {
  it("is the centered 90% box", () => {
    expect(centeredFallbackRect(1000, 400)).toStrictEqual({ x: 50, y: 20, w: 900, h: 360 });
  });
});

describe("autoDetectRect", () => {
  it("finds a dark card on a light ground, padded by 1.5% of each axis", () => {
    // A 100x60 detect pass over a 100x60 source, so detect coords are source
    // coords. The card occupies x 20..79, y 12..47. The Sobel gradient spans
    // one pixel either side of each border, so the energy band is x 19..80 /
    // y 11..48; the 1.5% pad (1.5px wide, 0.9px tall) then widens it.
    const img = buffer(100, 60, { rect: { x: 20, y: 12, w: 60, h: 36 } });
    expect(autoDetectRect(100, 60, img)).toStrictEqual({ x: 17.5, y: 10.1, w: 65, h: 39.8 });
  });

  it("tracks the card when it moves, rather than returning a fixed box", () => {
    const left = autoDetectRect(
      100,
      100,
      buffer(100, 100, { rect: { x: 5, y: 40, w: 30, h: 30 } }),
    );
    const right = autoDetectRect(
      100,
      100,
      buffer(100, 100, { rect: { x: 60, y: 40, w: 30, h: 30 } }),
    );
    expect(left.x).toBeLessThan(right.x);
  });

  it("projects detect-space coordinates back up to the source image size", () => {
    // Same 100x60 detection, but the source is 10x larger in both axes.
    const img = buffer(100, 60, { rect: { x: 20, y: 12, w: 60, h: 36 } });
    const small = autoDetectRect(100, 60, img);
    const large = autoDetectRect(1000, 600, img);
    expect(large.x).toBeCloseTo(small.x * 10, 5);
    expect(large.y).toBeCloseTo(small.y * 10, 5);
    expect(large.w).toBeCloseTo(small.w * 10, 5);
    expect(large.h).toBeCloseTo(small.h * 10, 5);
  });

  it("never returns a box that runs off the source image", () => {
    // Card bleeding off every edge: the pad would push the box outside.
    const img = buffer(80, 80, { rect: { x: 0, y: 0, w: 80, h: 80 } });
    const r = autoDetectRect(80, 80, img);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(80);
    expect(r.y + r.h).toBeLessThanOrEqual(80);
  });

  it("returns the whole frame for a blank image, where there is no edge energy at all", () => {
    // total <= 0 on both axes, so tighten yields [0, len-1]: the full frame
    // plus the pad, clamped back to the image.
    const r = autoDetectRect(200, 120, buffer(40, 24));
    expect(r).toStrictEqual({ x: 0, y: 0, w: 200, h: 120 });
  });

  it("falls back to the centered 90% box when the detected box collapses", () => {
    // A single dark column carries every scrap of column energy, so the
    // horizontal tighten collapses to a sliver well under 20% of the width.
    const img = buffer(100, 100, { rect: { x: 50, y: 0, w: 1, h: 100 } });
    const r = autoDetectRect(100, 100, img);
    expect(r).toStrictEqual(centeredFallbackRect(100, 100));
  });

  it("applies the 20% floor per axis, so one collapsed axis triggers the fallback", () => {
    // A wide, one-pixel-tall stripe: columns are fine, rows collapse.
    const img = buffer(100, 100, { rect: { x: 0, y: 50, w: 100, h: 1 } });
    const r = autoDetectRect(100, 100, img);
    expect(r).toStrictEqual(centeredFallbackRect(100, 100));
  });

  it("survives a 2x2 image, which has no interior pixels to walk", () => {
    // The gradient loops (1 .. len-1) never execute, so every energy bucket
    // is zero and the frame comes back whole.
    const r = autoDetectRect(2, 2, buffer(2, 2, { rect: { x: 0, y: 0, w: 1, h: 1 } }));
    expect(r).toStrictEqual({ x: 0, y: 0, w: 2, h: 2 });
  });

  it("survives a 1x1 image", () => {
    expect(() => autoDetectRect(1, 1, buffer(1, 1))).not.toThrow();
    expect(autoDetectRect(1, 1, buffer(1, 1))).toStrictEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("survives a single-column and a single-row image", () => {
    expect(autoDetectRect(10, 40, buffer(1, 40))).toStrictEqual({ x: 0, y: 0, w: 10, h: 40 });
    expect(autoDetectRect(40, 10, buffer(40, 1))).toStrictEqual({ x: 0, y: 0, w: 40, h: 10 });
  });

  it("reads luminance, not a single channel, so a blue-on-black card is still found", () => {
    // Blue carries the smallest luminance coefficient (0.114). A card painted
    // only in blue against black is the weakest edge the grayscale pass can
    // see, and it still has to be located.
    const width = 60;
    const height = 60;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i + 3] = 255;
        if (x >= 20 && x < 40 && y >= 20 && y < 40) data[i + 2] = 255;
      }
    }
    expect(autoDetectRect(60, 60, { data, width, height })).toStrictEqual({
      x: 18.1,
      y: 18.1,
      w: 23.8,
      h: 23.8,
    });
  });

  it("ignores the alpha channel, so a transparent-but-dark card is still found", () => {
    const width = 60;
    const height = 60;
    const data = new Uint8ClampedArray(width * height * 4).fill(200);
    for (let y = 20; y < 40; y++) {
      for (let x = 20; x < 40; x++) {
        const i = (y * width + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 0; // fully transparent, but the RGB is what is read
      }
    }
    const r = autoDetectRect(60, 60, { data, width, height });
    expect(r.w).toBeLessThan(60);
    expect(r.x).toBeGreaterThan(10);
  });
});
