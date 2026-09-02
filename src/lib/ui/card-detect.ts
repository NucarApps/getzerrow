/**
 * Business-card auto-crop: find a tight bounding box around the card in a
 * photo by collecting per-row and per-column edge energy.
 *
 * Extracted out of `CardCropper.tsx` because it is pure arithmetic over a
 * pixel buffer — no DOM, no canvas — and is the part of the cropper worth
 * testing. The component keeps the canvas plumbing (downscale, drawImage,
 * getImageData) and calls this with the result.
 */

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * The subset of `ImageData` this reads. Structural so a test can hand it a
 * plain object with a synthetic buffer, rather than needing a real canvas.
 */
export type PixelBuffer = {
  data: Uint8ClampedArray | number[];
  width: number;
  height: number;
};

/** Chop this fraction of the total edge energy off each end of an axis. */
const TIGHTEN_FRACTION = 0.025;
/** Pad the detected box by this fraction of the source dimension. */
const PAD_FRACTION = 0.015;
/** Below this fraction of the source dimension the detection is judged to have collapsed. */
const MIN_DIMENSION_FRACTION = 0.2;

/**
 * The centered 90% rectangle used whenever detection is impossible or its
 * answer is nonsense — no 2D context, a getImageData that throws (a tainted
 * canvas), a collapsed box, or the user pressing Reset.
 */
export function centeredFallbackRect(imgW: number, imgH: number): Rect {
  return { x: imgW * 0.05, y: imgH * 0.05, w: imgW * 0.9, h: imgH * 0.9 };
}

/**
 * Find the card's bounding box in source-image coordinates.
 *
 * `imgW`/`imgH` are the full-size image dimensions; `imageData` is a
 * downscaled render of the same image, so the result is projected back up.
 * Falls back to {@link centeredFallbackRect} when the box comes out smaller
 * than 20% of either source dimension.
 */
export function autoDetectRect(imgW: number, imgH: number, imageData: PixelBuffer): Rect {
  const { data, width: w, height: h } = imageData;
  // Sobel-like horizontal+vertical gradient magnitude per pixel (grayscale).
  const gray = new Float32Array(w * h);
  // Index math below is guaranteed in-bounds by the loop conditions (RGBA
  // stride of 4; interior pixels only), so non-null assertions are safe.
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
  }
  const rowE = new Float32Array(h);
  const colE = new Float32Array(w);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = Math.abs(gray[i + 1]! - gray[i - 1]!);
      const gy = Math.abs(gray[i + w]! - gray[i - w]!);
      const g = gx + gy;
      rowE[y]! += g;
      colE[x]! += g;
    }
  }
  const tighten = (energy: Float32Array, len: number): [number, number] => {
    let total = 0;
    for (let i = 0; i < len; i++) total += energy[i]!;
    if (total <= 0) return [0, len - 1];
    const drop = total * TIGHTEN_FRACTION;
    let acc = 0;
    let lo = 0;
    for (let i = 0; i < len; i++) {
      acc += energy[i]!;
      if (acc >= drop) {
        lo = i;
        break;
      }
    }
    acc = 0;
    let hi = len - 1;
    for (let i = len - 1; i >= 0; i--) {
      acc += energy[i]!;
      if (acc >= drop) {
        hi = i;
        break;
      }
    }
    return [lo, hi];
  };
  const [y0, y1] = tighten(rowE, h);
  const [x0, x1] = tighten(colE, w);
  // Project back to source image coords and pad slightly.
  const sx = imgW / w;
  const sy = imgH / h;
  const padX = imgW * PAD_FRACTION;
  const padY = imgH * PAD_FRACTION;
  const rx = Math.max(0, x0 * sx - padX);
  const ry = Math.max(0, y0 * sy - padY);
  const rw = Math.min(imgW - rx, (x1 - x0 + 1) * sx + padX * 2);
  const rh = Math.min(imgH - ry, (y1 - y0 + 1) * sy + padY * 2);
  // Sanity fallback to a centered 90% rectangle if detection collapsed.
  if (rw < imgW * MIN_DIMENSION_FRACTION || rh < imgH * MIN_DIMENSION_FRACTION) {
    return centeredFallbackRect(imgW, imgH);
  }
  return { x: rx, y: ry, w: rw, h: rh };
}
