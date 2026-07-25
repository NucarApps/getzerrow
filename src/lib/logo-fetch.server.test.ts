// The provider walk, redirect loop, and cache had ZERO test coverage before
// they were consolidated — only the guard primitives they call
// (`logo-guards.ts`) were tested. These pin the behaviors a future edit to the
// shared fetcher would otherwise break silently.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hostResolvesToPublicIp = vi.fn(async (_d: string) => true);
const isBlockedDomain = vi.fn((_d: string) => false);

vi.mock("@/lib/logo-guards", () => ({
  hostResolvesToPublicIp: (d: string) => hostResolvesToPublicIp(d),
  isBlockedDomain: (d: string) => isBlockedDomain(d),
  isValidDomainShape: (_d: string) => true,
}));

import {
  providersFor,
  snapLogoSize,
  fetchLogoBytes,
  createLogoCache,
  MIN_BYTES,
  MAX_BYTES,
} from "./logo-fetch.server";

function imageResponse(bytes: number, opts: { type?: string; length?: string } = {}) {
  const headers = new Headers({ "content-type": opts.type ?? "image/png" });
  if (opts.length !== undefined) headers.set("content-length", opts.length);
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}

function redirectTo(location: string, status = 302) {
  return new Response(null, { status, headers: new Headers({ location }) });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hostResolvesToPublicIp.mockReset().mockResolvedValue(true);
  isBlockedDomain.mockReset().mockReturnValue(false);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("providersFor", () => {
  it("returns the 7 providers in the persisted order", () => {
    const urls = providersFor("acme.com");
    expect(urls).toHaveLength(7);
    // company_logo_choices.provider stores this index — order is a data
    // contract, not a preference.
    expect(urls[0]).toContain("img.logo.dev");
    expect(urls[1]).toContain("logo.clearbit.com");
    expect(urls[2]).toContain("icons.duckduckgo.com");
    expect(urls[3]).toContain("apple-touch-icon.png");
    expect(urls[4]).toContain("apple-touch-icon-precomposed.png");
    expect(urls[5]).toContain("favicon.ico");
    expect(urls[6]).toContain("google.com/s2/favicons");
  });

  it("stays parallel to LOGO_PROVIDER_LABELS", async () => {
    const { LOGO_PROVIDER_COUNT } = await import("./logo-providers");
    expect(providersFor("acme.com")).toHaveLength(LOGO_PROVIDER_COUNT);
  });

  it("threads the requested size into the sized providers", () => {
    const urls = providersFor("acme.com", 512);
    expect(urls[0]).toContain("size=512");
    expect(urls[1]).toContain("size=512");
  });

  it("percent-encodes the domain in query position", () => {
    expect(providersFor("a b.com")[0]).toContain("a%20b.com");
  });
});

describe("snapLogoSize", () => {
  // The bug: the old clamp only collapsed values outside [256,512], so
  // ?size=300 and ?size=301 were distinct cache keys AND distinct upstream
  // URLs — ~257 fanouts per domain from an unauthenticated endpoint.
  it("collapses the whole 256..512 band to two buckets", () => {
    const sizes = [64, 256, 257, 300, 301, 399, 512, 9999];
    expect(new Set(sizes.map(snapLogoSize))).toEqual(new Set([256, 512]));
  });

  it("maps <=256 to 256 and >256 to 512", () => {
    expect(snapLogoSize(64)).toBe(256);
    expect(snapLogoSize(256)).toBe(256);
    expect(snapLogoSize(257)).toBe(512);
    expect(snapLogoSize(4096)).toBe(512);
  });

  it("defaults to 256 for junk input", () => {
    expect(snapLogoSize(NaN)).toBe(256);
    expect(snapLogoSize(null)).toBe(256);
    expect(snapLogoSize(undefined)).toBe(256);
  });
});

describe("fetchLogoBytes — guards", () => {
  it("refuses non-https", async () => {
    expect(await fetchLogoBytes("http://acme.com/logo.png")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a blocked host", async () => {
    isBlockedDomain.mockReturnValue(true);
    expect(await fetchLogoBytes("https://localhost/logo.png")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a host that does not resolve to a public IP", async () => {
    hostResolvesToPublicIp.mockResolvedValue(false);
    expect(await fetchLogoBytes("https://acme.com/logo.png")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses credentials embedded in the URL", async () => {
    expect(await fetchLogoBytes("https://user:pass@acme.com/logo.png")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches with redirect:manual and a timeout signal", async () => {
    fetchMock.mockResolvedValue(imageResponse(1000));
    await fetchLogoBytes("https://acme.com/logo.png");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
  });
});

describe("fetchLogoBytes — redirects", () => {
  it("follows a redirect and returns the final image", async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo("https://cdn.acme.com/logo.png"))
      .mockResolvedValueOnce(imageResponse(1000));
    const hit = await fetchLogoBytes("https://acme.com/logo.png");
    expect(hit?.bytes.byteLength).toBe(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-validates the host on EVERY hop", async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo("https://evil.internal/logo.png"))
      .mockResolvedValueOnce(imageResponse(1000));
    // Public on the first host, private on the redirect target.
    hostResolvesToPublicIp.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await fetchLogoBytes("https://acme.com/logo.png")).toBeNull();
    expect(hostResolvesToPublicIp).toHaveBeenCalledTimes(2);
  });

  it("applies the blocklist to a redirect target", async () => {
    fetchMock.mockResolvedValueOnce(redirectTo("https://127.0.0.1/logo.png"));
    isBlockedDomain.mockReturnValueOnce(false).mockReturnValueOnce(true);
    expect(await fetchLogoBytes("https://acme.com/logo.png")).toBeNull();
  });

  it("rejects a redirect that smuggles credentials", async () => {
    fetchMock.mockResolvedValueOnce(redirectTo("https://user:pass@acme.com/logo.png"));
    expect(await fetchLogoBytes("https://acme.com/logo.png")).toBeNull();
  });

  it("gives up after the hop budget instead of looping", async () => {
    fetchMock.mockResolvedValue(redirectTo("https://acme.com/next.png"));
    expect(await fetchLogoBytes("https://acme.com/logo.png")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("gives up on a redirect with no Location", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }));
    expect(await fetchLogoBytes("https://acme.com/logo.png")).toBeNull();
  });
});

describe("fetchLogoBytes — response validation", () => {
  it("rejects a non-image content-type", async () => {
    fetchMock.mockResolvedValue(imageResponse(1000, { type: "text/html" }));
    expect(await fetchLogoBytes("https://acme.com/logo.png")).toBeNull();
  });

  it("accepts an uppercase content-type", async () => {
    fetchMock.mockResolvedValue(imageResponse(1000, { type: "IMAGE/PNG" }));
    expect(await fetchLogoBytes("https://acme.com/logo.png")).not.toBeNull();
  });

  it("strips the charset parameter from the reported mime", async () => {
    fetchMock.mockResolvedValue(imageResponse(1000, { type: "image/svg+xml; charset=utf-8" }));
    expect((await fetchLogoBytes("https://acme.com/logo.png"))?.mime).toBe("image/svg+xml");
  });

  it("rejects a body under MIN_BYTES (error page / tracking pixel)", async () => {
    fetchMock.mockResolvedValue(imageResponse(MIN_BYTES - 1));
    expect(await fetchLogoBytes("https://acme.com/logo.png")).toBeNull();
  });

  it("rejects a non-2xx", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await fetchLogoBytes("https://acme.com/logo.png")).toBeNull();
  });

  it("rejects an oversized body declared via content-length", async () => {
    fetchMock.mockResolvedValue(imageResponse(1000, { length: String(MAX_BYTES + 1) }));
    expect(await fetchLogoBytes("https://acme.com/logo.png")).toBeNull();
  });

  it("rejects an oversized body that lies about content-length", async () => {
    // The cap must hold even when the header understates the real size.
    fetchMock.mockResolvedValue(imageResponse(MAX_BYTES + 1024, { length: "1000" }));
    expect(await fetchLogoBytes("https://acme.com/logo.png")).toBeNull();
  });

  it("swallows network errors rather than throwing", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    expect(await fetchLogoBytes("https://acme.com/logo.png")).toBeNull();
  });
});

describe("createLogoCache", () => {
  it("round-trips a hit", () => {
    const c = createLogoCache<string>(10);
    c.write("k", "v");
    expect(c.read("k")?.hit).toBe("v");
  });

  it("caches misses so a dead domain isn't re-walked", () => {
    const c = createLogoCache<string>(10);
    c.write("k", null);
    const e = c.read("k");
    expect(e).not.toBeNull();
    expect(e?.hit).toBeNull();
  });

  it("returns null for an unknown key", () => {
    expect(createLogoCache<string>(10).read("nope")).toBeNull();
  });

  it("evicts the oldest entry at capacity", () => {
    const c = createLogoCache<string>(2);
    c.write("a", "1");
    c.write("b", "2");
    c.write("c", "3");
    expect(c.read("a")).toBeNull();
    expect(c.read("b")?.hit).toBe("2");
    expect(c.read("c")?.hit).toBe("3");
  });

  it("expires entries once the TTL passes", () => {
    vi.useFakeTimers();
    try {
      const c = createLogoCache<string>(10);
      c.write("k", "v");
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
      expect(c.read("k")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
