// Tests for the logo dominant-colour reader (src/lib/logo-color.ts).
//
// Two things matter here. The cache tiers: every miss costs an image
// download and a canvas decode, so a null answer ("this domain has no
// usable logo") has to be remembered as firmly as a colour — otherwise a
// logoless company re-downloads on every render. And the bucketing: the
// tint has to come from the brand mark, not from the white background or
// the black outline that dominate almost every logo by pixel count.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  dominantColorFromPixels,
  getLogoDominantColor,
  resetLogoColorCache,
  setLogoSampler,
} from "./logo-color";

/** RGBA pixel runs, flattened the way getImageData hands them over. */
function pixels(
  ...runs: Array<{ rgba: [number, number, number, number]; count: number }>
): number[] {
  const out: number[] = [];
  for (const { rgba, count } of runs) {
    for (let i = 0; i < count; i++) out.push(...rgba);
  }
  return out;
}

/** A sessionStorage stand-in; `fail` makes every access throw the way a
 * privacy-mode browser does. */
function makeSessionStorage(options: { fail?: boolean } = {}) {
  const store = new Map<string, string>();
  return {
    store,
    api: {
      getItem(key: string) {
        if (options.fail) throw new Error("access denied");
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        if (options.fail) throw new Error("access denied");
        store.set(key, value);
      },
    },
  };
}

let session = makeSessionStorage();

beforeEach(() => {
  resetLogoColorCache();
  session = makeSessionStorage();
  vi.stubGlobal("sessionStorage", session.api);
});

afterEach(() => {
  setLogoSampler(null);
});

/* -------------------------------------------------------------------------- */
/* dominantColorFromPixels                                                     */
/* -------------------------------------------------------------------------- */

describe("dominantColorFromPixels", () => {
  it("picks the heaviest hue bin and returns its mean colour", () => {
    const data = pixels(
      { rgba: [200, 0, 0, 255], count: 10 }, // red
      { rgba: [0, 0, 200, 255], count: 3 }, // some blue
    );

    expect(dominantColorFromPixels(data)).toBe("rgb(200, 0, 0)");
  });

  it("averages the pixels inside the winning bin", () => {
    const data = pixels(
      { rgba: [200, 0, 0, 255], count: 1 },
      { rgba: [220, 20, 20, 255], count: 1 },
    );

    expect(dominantColorFromPixels(data)).toBe("rgb(210, 10, 10)");
  });

  it("ignores the white background and the black outline that dominate a logo", () => {
    const data = pixels(
      { rgba: [255, 255, 255, 255], count: 500 }, // background
      { rgba: [0, 0, 0, 255], count: 200 }, // outline
      { rgba: [0, 128, 0, 255], count: 5 }, // the actual mark
    );

    expect(dominantColorFromPixels(data)).toBe("rgb(0, 128, 0)");
  });

  it("ignores near-neutral greys, however many of them there are", () => {
    const data = pixels(
      { rgba: [130, 128, 126, 255], count: 900 },
      { rgba: [0, 0, 200, 255], count: 4 },
    );

    expect(dominantColorFromPixels(data)).toBe("rgb(0, 0, 200)");
  });

  it("ignores transparent pixels", () => {
    const data = pixels(
      { rgba: [255, 0, 0, 10], count: 100 },
      { rgba: [0, 0, 200, 255], count: 2 },
    );

    expect(dominantColorFromPixels(data)).toBe("rgb(0, 0, 200)");
  });

  it("returns null for a greyscale mark with no colour to take", () => {
    const data = pixels(
      { rgba: [255, 255, 255, 255], count: 100 },
      { rgba: [10, 10, 10, 255], count: 100 },
    );

    expect(dominantColorFromPixels(data)).toBeNull();
  });

  it("returns null for an empty image", () => {
    expect(dominantColorFromPixels([])).toBeNull();
  });

  it("bins a magenta mark into the last hue bucket rather than overflowing", () => {
    const data = pixels({ rgba: [200, 0, 190, 255], count: 4 });

    expect(dominantColorFromPixels(data)).toBe("rgb(200, 0, 190)");
  });
});

/* -------------------------------------------------------------------------- */
/* getLogoDominantColor — cache tiers                                          */
/* -------------------------------------------------------------------------- */

describe("getLogoDominantColor", () => {
  it("samples the logo once and serves every later call from memory", async () => {
    const sample = vi.fn(async (_url: string) => "rgb(1, 2, 3)");
    setLogoSampler(sample);

    expect(await getLogoDominantColor("acme.test")).toBe("rgb(1, 2, 3)");
    expect(await getLogoDominantColor("acme.test")).toBe("rgb(1, 2, 3)");

    expect(sample).toHaveBeenCalledTimes(1);
    expect(sample.mock.calls[0]?.[0]).toContain("domain=acme.test");
  });

  it("remembers a miss so a logoless domain is not re-downloaded", async () => {
    const sample = vi.fn(async () => null);
    setLogoSampler(sample);

    expect(await getLogoDominantColor("nologo.test")).toBeNull();
    expect(await getLogoDominantColor("nologo.test")).toBeNull();

    expect(sample).toHaveBeenCalledTimes(1);
    // Persisted as the empty string, which reads back as "known: no colour".
    expect(session.store.get("logoColor:nologo.test")).toBe("");
  });

  it("serves a colour written by an earlier page from sessionStorage", async () => {
    session.store.set("logoColor:acme.test", "rgb(9, 9, 9)");
    const sample = vi.fn(async () => "rgb(1, 2, 3)");
    setLogoSampler(sample);

    expect(await getLogoDominantColor("acme.test")).toBe("rgb(9, 9, 9)");
    expect(sample).not.toHaveBeenCalled();
  });

  it("serves a miss written by an earlier page without re-sampling", async () => {
    session.store.set("logoColor:nologo.test", "");
    const sample = vi.fn(async () => "rgb(1, 2, 3)");
    setLogoSampler(sample);

    expect(await getLogoDominantColor("nologo.test")).toBeNull();
    expect(sample).not.toHaveBeenCalled();
  });

  it("keeps working when sessionStorage is unavailable", async () => {
    const blocked = makeSessionStorage({ fail: true });
    vi.stubGlobal("sessionStorage", blocked.api);
    const sample = vi.fn(async () => "rgb(1, 2, 3)");
    setLogoSampler(sample);

    expect(await getLogoDominantColor("acme.test")).toBe("rgb(1, 2, 3)");
    // The memory tier still spares the second download.
    expect(await getLogoDominantColor("acme.test")).toBe("rgb(1, 2, 3)");
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it("caches nothing across a reset, so a re-sample can find a new logo", async () => {
    const sample = vi.fn(async () => "rgb(1, 2, 3)");
    setLogoSampler(sample);
    await getLogoDominantColor("acme.test");

    resetLogoColorCache();
    session.store.clear();
    await getLogoDominantColor("acme.test");

    expect(sample).toHaveBeenCalledTimes(2);
  });

  it("gives up with a null after the sample timeout instead of hanging", async () => {
    vi.useFakeTimers();
    setLogoSampler(() => new Promise<string | null>(() => {}));

    const pending = getLogoDominantColor("slow.test");
    await vi.advanceTimersByTimeAsync(6000);

    expect(await pending).toBeNull();
  });
});
