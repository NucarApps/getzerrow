import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Theme id -> [stop1, stop2, stop3] hex
const THEME_GRADIENTS: Record<string, [string, string, string]> = {
  default: ["#6366f1", "#4f46e5", "#1e1b4b"],
  sunset:  ["#f97316", "#ec4899", "#9333ea"],
  ocean:   ["#06b6d4", "#2563eb", "#3730a3"],
  forest:  ["#10b981", "#16a34a", "#0f766e"],
  noir:    ["#3f3f46", "#18181b", "#000000"],
  rose:    ["#fb7185", "#ec4899", "#c026d3"],
  amber:   ["#fbbf24", "#f97316", "#ef4444"],
  mono:    ["#e5e5e5", "#a3a3a3", "#525252"],
};

function esc(s: string | null | undefined) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncate(s: string, max: number) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export const Route = createFileRoute("/api/public/og/card/$handle")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const handle = String(params.handle ?? "").toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{2,30}$/.test(handle)) {
          return new Response("Not found", { status: 404 });
        }

        const { data: card } = await supabaseAdmin
          .from("my_cards")
          .select("handle,name,title,company,tagline,avatar_url,cover_url,theme")
          .eq("handle", handle)
          .maybeSingle();

        if (!card) return new Response("Not found", { status: 404 });

        const W = 1200, H = 630;
        const [c1, c2, c3] = THEME_GRADIENTS[(card as any).theme ?? "default"] ?? THEME_GRADIENTS.default;
        const name = truncate(card.name ?? card.handle, 40);
        const title = truncate([card.title, card.company].filter(Boolean).join(" · "), 60);
        const tagline = card.tagline ? truncate(card.tagline, 90) : "";
        const initial = (card.name ?? card.handle).slice(0, 1).toUpperCase();
        const cover = (card as any).cover_url as string | null;
        const avatar = (card as any).avatar_url as string | null;

        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="55%" stop-color="${c2}"/>
      <stop offset="100%" stop-color="${c3}"/>
    </linearGradient>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.55"/>
    </linearGradient>
    <clipPath id="avatarClip"><circle cx="140" cy="350" r="92"/></clipPath>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="8"/>
      <feOffset dx="0" dy="4"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.45"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${cover ? `<image href="${esc(cover)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice" opacity="0.55"/>` : ""}
  <rect width="${W}" height="${H}" fill="url(#scrim)"/>

  <!-- Avatar -->
  ${avatar
    ? `<circle cx="140" cy="350" r="98" fill="#ffffff"/>
       <image href="${esc(avatar)}" x="48" y="258" width="184" height="184" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>`
    : `<circle cx="140" cy="350" r="92" fill="#ffffff" fill-opacity="0.18" stroke="#ffffff" stroke-opacity="0.35" stroke-width="2"/>
       <text x="140" y="378" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="84" font-weight="700" fill="#ffffff">${esc(initial)}</text>`}

  <!-- Text -->
  <text x="270" y="335" font-family="Inter, system-ui, sans-serif" font-size="68" font-weight="800" fill="#ffffff" filter="url(#softShadow)">${esc(name)}</text>
  ${title ? `<text x="270" y="385" font-family="Inter, system-ui, sans-serif" font-size="30" font-weight="500" fill="#ffffff" fill-opacity="0.92">${esc(title)}</text>` : ""}
  ${tagline ? `<text x="270" y="438" font-family="Inter, system-ui, sans-serif" font-size="26" font-style="italic" fill="#ffffff" fill-opacity="0.82">"${esc(tagline)}"</text>` : ""}

  <!-- Footer -->
  <text x="60" y="565" font-family="Inter, system-ui, sans-serif" font-size="22" font-weight="600" fill="#ffffff" fill-opacity="0.85" letter-spacing="2">ZERROW · CONTACT CARD</text>
  <text x="${W - 60}" y="565" text-anchor="end" font-family="Inter, system-ui, sans-serif" font-size="22" font-weight="500" fill="#ffffff" fill-opacity="0.7">getzerrow.com/c/${esc(card.handle)}</text>
</svg>`;

        return new Response(svg, {
          status: 200,
          headers: {
            "Content-Type": "image/svg+xml; charset=utf-8",
            "Cache-Control": "public, max-age=300, s-maxage=600",
          },
        });
      },
    },
  },
});
