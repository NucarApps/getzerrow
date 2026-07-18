// Server-only helper that fetches a company logo as raw bytes so we can
// inline it as a CardDAV `PHOTO` for contacts that don't have their own
// picture. Mirrors the provider/guard logic used by /api/public/logo, and
// keeps a small in-memory cache so filling a whole address book doesn't
// hammer upstream providers.
import {
  hostResolvesToPublicIp,
  isBlockedDomain,
  isValidDomainShape,
} from "@/lib/logo-guards";
import { contactLogoDomain } from "@/lib/company-domains";

const MIN_BYTES = 600;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;

type CacheEntry = { hit: { bytes: Uint8Array; mime: string } | null; expires: number };
const cache = new Map<string, CacheEntry>();

function readCache(key: string): CacheEntry | null {
  const e = cache.get(key);
  if (!e) return null;
  if (e.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return e;
}

function writeCache(key: string, hit: CacheEntry["hit"]): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { hit, expires: Date.now() + (hit ? HIT_TTL_MS : MISS_TTL_MS) });
}

/** Provider URLs in the same order as `LOGO_PROVIDER_LABELS` and the
 * `/api/public/logo` proxy. Keep in sync with both. */
function providersFor(domain: string): string[] {
  const d = encodeURIComponent(domain);
  const size = 256;
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

async function tryFetch(url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    let current = url;
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
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!ct.startsWith("image/")) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength < MIN_BYTES) return null;
      const mime = ct.split(";")[0].trim() || "image/png";
      return { bytes: buf, mime };
    }
    return null;
  } catch {
    return null;
  }
}

/** Fetch a logo for `domain` and return bytes + mime, or null if none of the
 * providers succeeds. Cached in-memory. */
export async function fetchCompanyLogoBytes(
  domain: string | null,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (!domain) return null;
  const d = domain.toLowerCase();
  if (!isValidDomainShape(d) || isBlockedDomain(d)) return null;
  const cached = readCache(d);
  if (cached) return cached.hit;
  for (const url of providersFor(d)) {
    const hit = await tryFetch(url);
    if (hit) {
      writeCache(d, hit);
      return hit;
    }
  }
  writeCache(d, null);
  return null;
}

/** Best-guess logo domain for a contact row (website beats email). Returns
 * null for personal-email-only contacts (gmail, icloud, etc.). */
export function logoDomainForContact(row: {
  website?: string | null;
  email?: string | null;
}): string | null {
  return contactLogoDomain(row.website ?? null, row.email ?? null);
}
