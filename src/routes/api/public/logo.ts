import { createFileRoute } from "@tanstack/react-router";
import { isBlockedDomain, isValidDomainShape } from "@/lib/logo-guards";
import {
  providersFor,
  fetchLogoBytes,
  createLogoCache,
  snapLogoSize,
  MIN_BYTES,
} from "@/lib/logo-fetch.server";

// Bytes are buffered here (rather than streamed straight through) because the
// same buffer is what goes into the cache.
type CacheHit = { buf: ArrayBuffer; contentType: string };
const logoCache = createLogoCache<CacheHit>(2000);

export const Route = createFileRoute("/api/public/logo")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const domain = (url.searchParams.get("domain") || "").trim().toLowerCase();
        // Snap to one of two buckets. The previous clamp only collapsed values
        // OUTSIDE [256,512], so ?size=300 and ?size=301 remained distinct cache
        // keys AND distinct upstream URLs — an anonymous caller could walk the
        // band for ~257 upstream fanouts on one domain and, because eviction is
        // insertion-ordered, flush every legitimately cached logo doing it.
        const size = snapLogoSize(Number(url.searchParams.get("size") || "64"));
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
        const cached = logoCache.read(cacheKey);
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
          const hit = await fetchLogoBytes(candidate);
          if (!hit) continue;
          if (hit.bytes.byteLength < MIN_BYTES) continue;
          const buf = hit.bytes.buffer.slice(
            hit.bytes.byteOffset,
            hit.bytes.byteOffset + hit.bytes.byteLength,
          ) as ArrayBuffer;
          const contentType = hit.mime;
          logoCache.write(cacheKey, { buf, contentType });
          return new Response(buf, {
            status: 200,
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=2592000, s-maxage=2592000, immutable",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
        logoCache.write(cacheKey, null);
        return new Response("Not found", {
          status: 404,
          headers: { "Cache-Control": "public, max-age=3600" },
        });
      },
    },
  },
});
