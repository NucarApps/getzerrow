import { createFileRoute } from "@tanstack/react-router";

const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

function providersFor(domain: string, size: number): string[] {
  const d = encodeURIComponent(domain);
  const s = Math.max(128, Math.min(512, size));
  return [
    `https://logo.clearbit.com/${d}?size=${s}`,
    `https://www.google.com/s2/favicons?domain=${d}&sz=${Math.min(s, 256)}`,
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
    if (len && len < 80) return null; // skip tiny 1x1 placeholders
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
          if (buf.byteLength < 80) continue;
          return new Response(buf, {
            status: 200,
            headers: {
              "Content-Type": res.headers.get("content-type") || "image/png",
              "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
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
