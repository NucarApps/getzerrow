// Dominant brand colour for a company logo, used to tint contact and
// company cards.
//
// Three cache tiers, cheapest first: a module-level memo (same tab, same
// session), sessionStorage (survives a client-side navigation), then an
// actual image decode. A miss is cached as null too — a domain with no
// usable logo must not re-download on every render.
import { logoCandidates } from "./company-domains";

const memCache = new Map<string, string | null>();
const STORAGE_PREFIX = "logoColor:";
const SAMPLE_TIMEOUT_MS = 6000;

function readSession(domain: string): string | null | undefined {
  try {
    const v = sessionStorage.getItem(STORAGE_PREFIX + domain);
    if (v === null) return undefined;
    return v === "" ? null : v;
  } catch {
    return undefined;
  }
}
function writeSession(domain: string, color: string | null) {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + domain, color ?? "");
  } catch {
    /* ignore */
  }
}

/** Drop the in-memory tier. Tests use it to isolate cases; production has
 * no reason to call it — the memo is meant to live as long as the tab. */
export function resetLogoColorCache(): void {
  memCache.clear();
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0,
    s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }
  return [h, s, l];
}

/**
 * The brand colour of one decoded logo: RGBA pixels in, `rgb(r, g, b)` out.
 *
 * Pixels are dropped when they are transparent, near-white/black or
 * near-neutral — a logo is mostly its background and its outline, and both
 * would otherwise win. What survives is binned into 12 hues weighted by
 * saturation and mid-lightness, and the heaviest bin's mean colour wins.
 * Returns null when nothing survived (a greyscale or empty mark).
 *
 * Pure, and exported so the bucketing is testable without a canvas.
 */
export function dominantColorFromPixels(data: Uint8ClampedArray | number[]): string | null {
  const bins = Array.from({ length: 12 }, () => ({
    weight: 0,
    r: 0,
    g: 0,
    b: 0,
    count: 0,
  }));
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === undefined || a < 200) continue;
    const r = data[i] ?? 0,
      g = data[i + 1] ?? 0,
      b = data[i + 2] ?? 0;
    const [h, s, l] = rgbToHsl(r, g, b);
    if (l < 0.08 || l > 0.92) continue; // ignore near-white/black
    if (s < 0.25) continue; // ignore near-neutral
    const bin = Math.min(11, Math.floor(h / 30));
    const entry = bins[bin];
    if (!entry) continue;
    const w = s * (1 - Math.abs(l - 0.5));
    entry.weight += w;
    entry.r += r;
    entry.g += g;
    entry.b += b;
    entry.count++;
  }
  let best = -1,
    bestW = 0;
  for (let i = 0; i < bins.length; i++) {
    const bi = bins[i]!; // i < bins.length, dense array
    if (bi.weight > bestW) {
      bestW = bi.weight;
      best = i;
    }
  }
  if (best < 0) return null;
  const b = bins[best];
  if (!b) return null;
  const r = Math.round(b.r / b.count);
  const g = Math.round(b.g / b.count);
  const bl = Math.round(b.b / b.count);
  return `rgb(${r}, ${g}, ${bl})`;
}

function extractFromImage(img: HTMLImageElement): string | null {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null; // CORS taint
  }
  return dominantColorFromPixels(data);
}

/**
 * Sample one candidate URL. Resolves to the colour, or null when the image
 * failed to load, was CORS-tainted, or held no usable colour — in every one
 * of those cases the caller moves on to the next candidate.
 */
export type LogoSampler = (url: string) => Promise<string | null>;

const sampleWithImage: LogoSampler = (url) =>
  new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.onload = () => resolve(extractFromImage(img));
    img.onerror = () => resolve(null);
    img.src = url;
  });

let sampler: LogoSampler = sampleWithImage;

/** Swap the image decode for a stub. Passing null restores the real one. */
export function setLogoSampler(next: LogoSampler | null): void {
  sampler = next ?? sampleWithImage;
}

export async function getLogoDominantColor(domain: string): Promise<string | null> {
  // `has` rather than a truthiness check: a cached null is a real answer
  // ("this domain has no usable logo"), not a miss.
  if (memCache.has(domain)) return memCache.get(domain) ?? null;
  const stored = readSession(domain);
  if (stored !== undefined) {
    memCache.set(domain, stored);
    return stored;
  }

  const color = await withTimeout(walkCandidates(domain), SAMPLE_TIMEOUT_MS);
  memCache.set(domain, color);
  writeSession(domain, color);
  return color;
}

/** First candidate that yields a colour wins; a candidate that fails to
 * load or has no usable colour falls through to the next. */
async function walkCandidates(domain: string): Promise<string | null> {
  for (const url of logoCandidates(domain, 64)) {
    const color = await sampler(url);
    if (color) return color;
  }
  return null;
}

/** A logo host that never answers must not leave the caller hanging. */
function withTimeout(work: Promise<string | null>, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void work.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
