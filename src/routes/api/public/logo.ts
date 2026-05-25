import { createFileRoute } from "@tanstack/react-router";

const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

// Block internal/reserved hostnames, link-local, and wildcard-DNS SSRF tricks.
const BLOCKED_HOST_RE =
  /(^|\.)(localhost|local|internal|intranet|corp|home|lan|test|example|invalid|onion)$/i;
const BLOCKED_SUFFIX_RE = /\.(nip\.io|sslip\.io|xip\.io|localtest\.me)$/i;
const IP_LITERAL_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]+\]?$/i;
// Match IP-shaped labels embedded anywhere (e.g. 169.254.169.254.nip.io).
const EMBEDDED_IP_RE = /(?:^|\.)(?:10|127|0|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./;

function isBlockedDomain(domain: string): boolean {
  if (IP_LITERAL_RE.test(domain)) return true;
  if (BLOCKED_HOST_RE.test(domain)) return true;
  if (BLOCKED_SUFFIX_RE.test(domain)) return true;
  if (EMBEDDED_IP_RE.test(`.${domain}`)) return true;
  return false;
}

const ALLOWED_PROVIDER_HOSTS = new Set([
  "logo.clearbit.com",
  "img.logo.dev",
  "icons.duckduckgo.com",
  "www.google.com",
]);

function providersFor(domain: string, size: number): string[] {
  const d = encodeURIComponent(domain);
  const s = Math.max(256, Math.min(512, size));
  return [
    `https://logo.clearbit.com/${d}?size=${s}`,
    `https://img.logo.dev/${d}?size=${s}&format=png`,
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
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 ZerrowLogoBot" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) return null;
    const len = Number(res.headers.get("content-length") || "0");
    if (len && len < MIN_BYTES) return null;
    return res;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/public/logo")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const domain = (url.searchParams.get("domain") || "").trim().toLowerCase();
        const size = Number(url.searchParams.get("size") || "64");
        if (!domain || !DOMAIN_RE.test(domain)) {
          return new Response("Bad domain", { status: 400 });
        }
        for (const candidate of providersFor(domain, size)) {
          const res = await tryFetch(candidate);
          if (!res) continue;
          const buf = await res.arrayBuffer();
          if (buf.byteLength < MIN_BYTES) continue;
          return new Response(buf, {
            status: 200,
            headers: {
              "Content-Type": res.headers.get("content-type") || "image/png",
              "Cache-Control": "public, max-age=2592000, s-maxage=2592000, immutable",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
        return new Response("Not found", {
          status: 404,
          headers: { "Cache-Control": "public, max-age=3600" },
        });
      },
    },
  },
});
