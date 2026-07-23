import { createFileRoute } from "@tanstack/react-router";
import { hostResolvesToPublicIp, isBlockedDomain, isValidDomainShape } from "@/lib/logo-guards";

function providersFor(domain: string, size: number): string[] {
  const d = encodeURIComponent(domain);
  const s = Math.max(256, Math.min(512, size));
  const logoDevToken = process.env.LOGO_DEV_TOKEN;
  const logoDevUrl = `https://img.logo.dev/${d}?size=${s}&format=png${
    logoDevToken ? `&token=${encodeURIComponent(logoDevToken)}` : ""
  }`;
  return [
    logoDevUrl,
    `https://logo.clearbit.com/${d}?size=${s}`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://${domain}/apple-touch-icon.png`,
    `https://${domain}/apple-touch-icon-precomposed.png`,
    `https://${domain}/favicon.ico`,
    `https://www.google.com/s2/favicons?domain=${d}&sz=256`,
  ];
}

const MIN_BYTES = 600;

async function tryFetch(url: string): Promise<Response | null> {
  try {
    let current = url;
    // Manually follow up to 3 redirects, re-validating the host on each hop
    // so an attacker cannot 302 us into a private-network address after
    // passing the initial DNS check.
    //
    // Residual risk (documented, not fully closable on Cloudflare Workers):
    // `hostResolvesToPublicIp` resolves via DoH, then `fetch()` resolves the
    // host again itself — a DNS-rebinding attacker whose record flips to a
    // private IP between those two lookups could still be connected to by
    // fetch(). Workers' fetch() exposes no way to pin the connection to the
    // IP we validated (pinning to an IP would also break TLS SNI/cert
    // validation), so the check-then-fetch window cannot be eliminated here.
    // The per-hop re-validation below narrows it, and the static blocklist +
    // https-only + image-content-type checks bound the impact.
    for (let hop = 0; hop < 4; hop++) {
      const parsed = new URL(current);
      if (parsed.protocol !== "https:") return null;
      const host = parsed.hostname.toLowerCase();
      if (isBlockedDomain(host)) return null;
      if (!(await hostResolvesToPublicIp(host))) return null;

      const res = await fetch(current, {
        redirect: "manual",
        headers: { "user-agent": "Mozilla/5.0 ZerrowLogoBot" },
        signal: AbortSignal.timeout(4000),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) return null;
      const ct = res.headers.get("content-type") || "";
      if (!ct.startsWith("image/")) return null;
      const len = Number(res.headers.get("content-length") || "0");
      if (len && len < MIN_BYTES) return null;
      return res;
    }
    return null;
  } catch {
    return null;
  }
}

// In-memory cache to prevent repeated upstream fanout for the same logo.
// Because logos are loaded via <img src> (no Authorization header can be
// attached), the endpoint stays public; this cache plus the long CDN
// Cache-Control headers below are the defense against quota exhaustion and
// cost amplification from bulk/anonymous requests.
type CacheHit = { buf: ArrayBuffer; contentType: string };
type CacheEntry = { hit: CacheHit | null; expires: number };
const HIT_TTL_MS = 24 * 60 * 60 * 1000; // 24h for found logos
const MISS_TTL_MS = 60 * 60 * 1000; // 1h for negative results
const MAX_ENTRIES = 2000;
const logoCache = new Map<string, CacheEntry>();

function readCache(key: string): CacheEntry | null {
  const entry = logoCache.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    logoCache.delete(key);
    return null;
  }
  return entry;
}

function writeCache(key: string, hit: CacheHit | null): void {
  if (logoCache.size >= MAX_ENTRIES) {
    const oldest = logoCache.keys().next().value;
    if (oldest !== undefined) logoCache.delete(oldest);
  }
  logoCache.set(key, {
    hit,
    expires: Date.now() + (hit ? HIT_TTL_MS : MISS_TTL_MS),
  });
}

export const Route = createFileRoute("/api/public/logo")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const domain = (url.searchParams.get("domain") || "").trim().toLowerCase();
        // Clamp size to the same [256,512] band providersFor uses, so the
        // upstream URLs (and thus the cache entry) are identical for every
        // size in that band. Keying the cache on the raw size let a public
        // caller vary ?size= to bypass the anti-amplification cache and force
        // unbounded upstream fetches for one domain.
        const rawSize = Number(url.searchParams.get("size") || "64");
        const size = Number.isFinite(rawSize) ? Math.max(256, Math.min(512, rawSize)) : 256;
        const providerParam = url.searchParams.get("provider");
        if (!domain || !isValidDomainShape(domain) || isBlockedDomain(domain)) {
          return new Response("Bad domain", { status: 400 });
        }
        const all = providersFor(domain, size);
        let candidates = all;
        if (providerParam !== null) {
          const idx = Number(providerParam);
          if (!Number.isInteger(idx) || idx < 0 || idx >= all.length) {
            return new Response("Bad provider", { status: 400 });
          }
          candidates = [all[idx]];
        }

        const cacheKey = `${domain}|${size}|${providerParam ?? "*"}`;
        const cached = readCache(cacheKey);
        if (cached) {
          if (cached.hit) {
            return new Response(cached.hit.buf, {
              status: 200,
              headers: {
                "Content-Type": cached.hit.contentType,
                "Cache-Control": "public, max-age=2592000, s-maxage=2592000, immutable",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }
          return new Response("Not found", {
            status: 404,
            headers: { "Cache-Control": "public, max-age=3600" },
          });
        }

        for (const candidate of candidates) {
          const res = await tryFetch(candidate);
          if (!res) continue;
          const buf = await res.arrayBuffer();
          if (buf.byteLength < MIN_BYTES) continue;
          const contentType = res.headers.get("content-type") || "image/png";
          writeCache(cacheKey, { buf, contentType });
          return new Response(buf, {
            status: 200,
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=2592000, s-maxage=2592000, immutable",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
        writeCache(cacheKey, null);
        return new Response("Not found", {
          status: 404,
          headers: { "Cache-Control": "public, max-age=3600" },
        });
      },
    },
  },
});
