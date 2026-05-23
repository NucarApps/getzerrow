import { logoCandidates } from "./company-domains";

const memCache = new Map<string, string | null>();
const STORAGE_PREFIX = "logoColor:";

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

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      case b: h = ((r - g) / d + 4); break;
    }
    h *= 60;
  }
  return [h, s, l];
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

  // 12 hue bins; track summed saturation*weight + avg rgb per bin
  const bins = Array.from({ length: 12 }, () => ({
    weight: 0, r: 0, g: 0, b: 0, count: 0,
  }));
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 200) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);
    if (l < 0.08 || l > 0.92) continue; // ignore near-white/black
    if (s < 0.25) continue; // ignore near-neutral
    const bin = Math.min(11, Math.floor(h / 30));
    const w = s * (1 - Math.abs(l - 0.5));
    bins[bin].weight += w;
    bins[bin].r += r; bins[bin].g += g; bins[bin].b += b; bins[bin].count++;
  }
  let best = -1, bestW = 0;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i].weight > bestW) { bestW = bins[i].weight; best = i; }
  }
  if (best < 0) return null;
  const b = bins[best];
  const r = Math.round(b.r / b.count);
  const g = Math.round(b.g / b.count);
  const bl = Math.round(b.b / b.count);
  return `rgb(${r}, ${g}, ${bl})`;
}

export function getLogoDominantColor(domain: string): Promise<string | null> {
  if (memCache.has(domain)) return Promise.resolve(memCache.get(domain)!);
  const sess = readSession(domain);
  if (sess !== undefined) { memCache.set(domain, sess); return Promise.resolve(sess); }

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    let settled = false;
    const done = (c: string | null) => {
      if (settled) return;
      settled = true;
      memCache.set(domain, c);
      writeSession(domain, c);
      resolve(c);
    };
    img.onload = () => done(extractFromImage(img));
    img.onerror = () => done(null);
    img.src = logoUrl(domain, 64);
    // Safety timeout
    setTimeout(() => done(null), 5000);
  });
}
