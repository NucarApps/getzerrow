// Shared logo fetching: provider list, guarded fetch, and cache.
//
// The provider walk, the redirect loop, and the in-memory cache used to exist
// twice — once in `/api/public/logo` (the public proxy) and once in
// `contacts/logo-photo.server.ts` (the CardDAV / Google Contacts byte source).
// They had already drifted: different content-type handling, different
// min-bytes checks, and different sizes. The SSRF guard itself was never
// duplicated (both call `logo-guards.ts`), but a guarded fetch maintained in
// two places is one edit away from only being fixed in one of them.
//
// This module returns BYTES. The public route wraps them in a Response; every
// other consumer needs a Uint8Array to SHA-256 for the photo-echo guard.
import { hostResolvesToPublicIp, isBlockedDomain } from "@/lib/logo-guards";

/** Below this, the response is an error page or a 1x1 tracking pixel. */
export const MIN_BYTES = 600;

/**
 * Hard ceiling on a single logo. Nothing legitimate is close to this; the cap
 * exists because the upstream host is attacker-influenceable
 * (`https://<domain>/favicon.ico`, or any redirect target), and both caches
 * previously bounded entry COUNT but not total bytes.
 */
export const MAX_BYTES = 2 * 1024 * 1024;

/**
 * The only two sizes we ask upstream for.
 *
 * Snapping matters for more than tidiness: the cache key includes the size, so
 * accepting arbitrary values let an anonymous caller walk `?size=256..512` and
 * force ~257 upstream fetch fanouts for a single domain — and, because
 * eviction is insertion-ordered, flush every legitimately cached logo on the
 * way through. The previous clamp only collapsed values OUTSIDE the band,
 * which is not the same thing despite what its comment claimed.
 */
export function snapLogoSize(raw: number | null | undefined): 256 | 512 {
  if (!Number.isFinite(raw as number)) return 256;
  return (raw as number) <= 256 ? 256 : 512;
}

/**
 * Size used for every byte-hashing path (photo-echo / dedup SHA sets).
 *
 * Pinned so the SHAs stay stable. NOTE: the public proxy may serve 512 to the
 * browser for large avatars, and those bytes hash differently — a 512 logo
 * echoed back from a device will not match a 256-derived SHA set. Pre-existing;
 * tracked separately from this consolidation.
 */
export const LOGO_SHA_SIZE = 256;

/**
 * Logo providers, in priority order.
 *
 * ORDER IS LOAD-BEARING — the index is persisted as `company_logo_choices.provider`
 * and bounded by `LOGO_PROVIDER_COUNT` (see `logo-providers.ts`, whose labels
 * must stay parallel to this list). Reordering silently repoints saved picks.
 */
export function providersFor(domain: string, size: 256 | 512 = LOGO_SHA_SIZE): string[] {
  const d = encodeURIComponent(domain);
  const logoDevToken = process.env.LOGO_DEV_TOKEN;
  return [
    `https://img.logo.dev/${d}?size=${size}&format=png${
      logoDevToken ? `&token=${encodeURIComponent(logoDevToken)}` : ""
    }`,
    `https://logo.clearbit.com/${d}?size=${size}`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://${domain}/apple-touch-icon.png`,
    `https://${domain}/apple-touch-icon-precomposed.png`,
    `https://${domain}/favicon.ico`,
    `https://www.google.com/s2/favicons?domain=${d}&sz=256`,
  ];
}

/** Read at most `MAX_BYTES`, aborting the stream rather than buffering more. */
async function readCapped(res: Response): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") || "0");
  if (declared && declared > MAX_BYTES) return null;

  const body = res.body;
  if (!body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > MAX_BYTES ? null : buf;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Fetch one logo URL through the SSRF guard and return its bytes.
 *
 * Follows up to 3 redirects manually, re-validating the host on EVERY hop so an
 * attacker cannot 302 us into a private-network address after passing the
 * initial DNS check.
 *
 * Residual risk (documented, not closable on Cloudflare Workers):
 * `hostResolvesToPublicIp` resolves via DoH, then `fetch()` resolves the host
 * again itself — a DNS-rebinding attacker whose record flips to a private IP
 * between those two lookups could still be connected to. Workers' fetch()
 * exposes no way to pin the connection to the IP we validated (pinning would
 * also break TLS SNI/cert validation), so the check-then-fetch window cannot be
 * eliminated. The per-hop re-validation narrows it; the static blocklist,
 * https-only, image-content-type, and byte cap bound the impact.
 */
export async function fetchLogoBytes(
  url: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      const parsed = new URL(current);
      if (parsed.protocol !== "https:") return null;
      // Credentials in the URL are never legitimate here and can be used to
      // smuggle auth to an internal host. The sibling webhook guard rejects
      // these too (webhook/url-guard.ts).
      if (parsed.username || parsed.password) return null;
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

      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!ct.startsWith("image/")) return null;

      const bytes = await readCapped(res);
      if (!bytes || bytes.byteLength < MIN_BYTES) return null;

      const mime = ct.split(";")[0].trim() || "image/png";
      return { bytes, mime };
    }
    return null;
  } catch {
    return null;
  }
}

const HIT_TTL_MS = 24 * 60 * 60 * 1000; // 24h for found logos
const MISS_TTL_MS = 60 * 60 * 1000; // 1h for negative results

/**
 * Small in-memory cache with negative caching.
 *
 * Logos load via `<img src>`, so the proxy can't require an Authorization
 * header and stays public — this cache plus the long CDN Cache-Control headers
 * are the defense against quota exhaustion and cost amplification from bulk
 * anonymous requests. Per-isolate on Workers.
 *
 * Eviction is insertion-ordered (oldest key first), not LRU.
 */
export function createLogoCache<T>(maxEntries: number) {
  const map = new Map<string, { hit: T | null; expires: number }>();
  return {
    read(key: string): { hit: T | null } | null {
      const e = map.get(key);
      if (!e) return null;
      if (e.expires <= Date.now()) {
        map.delete(key);
        return null;
      }
      return e;
    },
    write(key: string, hit: T | null): void {
      if (map.size >= maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, { hit, expires: Date.now() + (hit ? HIT_TTL_MS : MISS_TTL_MS) });
    },
  };
}
