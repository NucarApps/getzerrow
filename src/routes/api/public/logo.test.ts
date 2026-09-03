// Contract for the public logo proxy. Deliberately unauthenticated, so its
// guards ARE its security model: only the SSRF-guarded fetch is faked here —
// the domain shape check, the blocklist, the provider list, the size snapping
// and the cache all stay real, because they are what is under test.
//
// The route holds one module-scoped cache for the life of the process, so
// every test uses its own domain rather than trying to reset it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "./__fixtures__/route-harness";
import { Route } from "./logo";

const fetchLogoBytes = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/logo-fetch.server").fetchLogoBytes>(),
);
vi.mock("@/lib/logo-fetch.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logo-fetch.server")>();
  return { ...actual, fetchLogoBytes };
});

const GET = handler(Route, "GET");

/** A PNG payload comfortably above the module's MIN_BYTES floor. */
function png(fill = 7): { bytes: Uint8Array; mime: string } {
  return { bytes: new Uint8Array(1024).fill(fill), mime: "image/png" };
}

async function get(query: Record<string, string>): Promise<Response> {
  const url = new URL("https://atzro.test/api/public/logo");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return GET({ request: new Request(url), params: {} });
}

beforeEach(() => {
  fetchLogoBytes.mockResolvedValue(png());
});

describe("input guards", () => {
  it.each([
    ["a missing domain", {}],
    ["an empty domain", { domain: "" }],
    ["a domain with a path", { domain: "acme.com/logo" }],
    ["a domain with a scheme", { domain: "https://acme.com" }],
    ["a domain with a port", { domain: "acme.com:8080" }],
    ["a bare label", { domain: "localhost" }],
  ])("refuses %s", async (_name, query) => {
    const res = await get(query);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Bad domain");
    expect(fetchLogoBytes).not.toHaveBeenCalled();
  });

  it.each([
    ["an IP literal", "127.0.0.1"],
    ["a private-range IP literal", "10.0.0.5"],
    ["an internal suffix", "printer.internal"],
    ["a host with an embedded private IP", "10.0.0.5.nip.io"],
  ])("refuses %s as an SSRF target", async (_name, domain) => {
    const res = await get({ domain });

    expect(res.status).toBe(400);
    expect(fetchLogoBytes).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-integer index", "1.5"],
    ["a negative index", "-1"],
    ["an index past the end of the provider list", "99"],
    ["a non-numeric index", "logodev"],
  ])("refuses %s for ?provider=", async (_name, provider) => {
    const res = await get({ domain: "provider-guard.com", provider });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Bad provider");
    expect(fetchLogoBytes).not.toHaveBeenCalled();
  });
});

describe("serving bytes", () => {
  it("returns the first provider's bytes with immutable public caching", async () => {
    const res = await get({ domain: "serve-first.com" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=2592000, s-maxage=2592000, immutable",
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(new Uint8Array(await res.arrayBuffer())).toHaveLength(1024);
    expect(fetchLogoBytes).toHaveBeenCalledTimes(1);
  });

  it("serves whatever content type the provider returned", async () => {
    fetchLogoBytes.mockResolvedValue({ bytes: new Uint8Array(1024), mime: "image/svg+xml" });

    const res = await get({ domain: "serve-mime.com" });

    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
  });

  it("walks past a provider that has nothing to give", async () => {
    fetchLogoBytes.mockResolvedValueOnce(null).mockResolvedValueOnce(png());

    const res = await get({ domain: "walk-null.com" });

    expect(res.status).toBe(200);
    expect(fetchLogoBytes).toHaveBeenCalledTimes(2);
  });

  it("walks past a response too small to be a real logo", async () => {
    // Under MIN_BYTES: an error page or a 1x1 tracking pixel, not a logo.
    fetchLogoBytes
      .mockResolvedValueOnce({ bytes: new Uint8Array(40), mime: "image/png" })
      .mockResolvedValueOnce(png());

    const res = await get({ domain: "walk-tiny.com" });

    expect(res.status).toBe(200);
    expect(fetchLogoBytes).toHaveBeenCalledTimes(2);
  });

  it("tries only the requested provider when ?provider= names one", async () => {
    const res = await get({ domain: "one-provider.com", provider: "2" });

    expect(res.status).toBe(200);
    expect(fetchLogoBytes).toHaveBeenCalledExactlyOnceWith(
      "https://icons.duckduckgo.com/ip3/one-provider.com.ico",
    );
  });
});

describe("size snapping", () => {
  it.each([
    ["the default", {}, 256],
    ["a small explicit size", { size: "64" }, 256],
    ["a value inside the old clamp band", { size: "300" }, 512],
    ["the band's lower edge", { size: "256" }, 256],
    ["a large size", { size: "1024" }, 512],
    ["a non-numeric size", { size: "big" }, 256],
  ])("snaps %s to %i", async (name, query, expected) => {
    // A distinct domain per case: the route's cache is module-scoped.
    const domain = `snap-${name.replace(/[^a-z]+/gi, "-")}.com`;

    await get({ domain, ...query });

    expect(fetchLogoBytes.mock.calls[0]?.[0]).toContain(`size=${expected}`);
  });

  it("collapses a walk of the old band onto one cache key and one upstream fetch", async () => {
    // ?size=300 and ?size=301 used to be distinct cache keys AND distinct
    // upstream URLs, so an anonymous caller could force ~257 fanouts on one
    // domain and flush the cache doing it.
    await get({ domain: "band-walk.com", size: "300" });
    await get({ domain: "band-walk.com", size: "301" });
    await get({ domain: "band-walk.com", size: "512" });

    expect(fetchLogoBytes).toHaveBeenCalledTimes(1);
  });
});

describe("caching", () => {
  it("serves a repeat request from memory without touching upstream", async () => {
    const first = await get({ domain: "cache-hit.com" });
    const second = await get({ domain: "cache-hit.com" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toHaveLength(1024);
    expect(fetchLogoBytes).toHaveBeenCalledTimes(1);
  });

  it("caches a miss too, so a logo-less domain cannot be used to fan out", async () => {
    fetchLogoBytes.mockResolvedValue(null);

    const first = await get({ domain: "cache-miss.com" });
    const callsAfterFirst = fetchLogoBytes.mock.calls.length;
    const second = await get({ domain: "cache-miss.com" });

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(second.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(fetchLogoBytes).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it("keys the cache by provider as well as domain and size", async () => {
    await get({ domain: "cache-key.com" });
    await get({ domain: "cache-key.com", provider: "0" });

    expect(fetchLogoBytes).toHaveBeenCalledTimes(2);
  });
});

describe("upstream failure", () => {
  it("degrades to a cacheable 404 when no provider has a logo", async () => {
    fetchLogoBytes.mockResolvedValue(null);

    const res = await get({ domain: "no-logo-anywhere.com" });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    // Every provider was tried before giving up.
    expect(fetchLogoBytes.mock.calls.length).toBeGreaterThan(1);
  });
});
