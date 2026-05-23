import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,30}$/;
const EVENT_TYPES = ["view", "link_click", "vcard_download", "share"] as const;
const LINK_KINDS = ["email", "phone", "website", "linkedin", "twitter", "other"] as const;

/** Public — log an event on a card. No auth required. */
export const logCardEvent = createServerFn({ method: "POST" })
  .inputValidator((d: any) =>
    z.object({
      handle: z.string().regex(HANDLE_RE),
      event_type: z.enum(EVENT_TYPES),
      link_kind: z.enum(LINK_KINDS).optional(),
      link_url: z.string().max(500).optional(),
      referrer: z.string().max(500).optional(),
    }).parse(d)
  )
  .handler(async ({ data, request }) => {
    const { data: card } = await supabaseAdmin
      .from("my_cards")
      .select("id, user_id")
      .eq("handle", data.handle.toLowerCase())
      .maybeSingle();
    if (!card) return { ok: false };

    const ua = request?.headers.get("user-agent")?.slice(0, 500) ?? null;

    await supabaseAdmin.from("card_events").insert({
      card_id: card.id,
      owner_user_id: card.user_id,
      handle: data.handle.toLowerCase(),
      event_type: data.event_type,
      link_kind: data.link_kind ?? null,
      link_url: data.link_url ?? null,
      referrer: data.referrer ?? null,
      user_agent: ua,
    });
    return { ok: true };
  });

export type CardAnalyticsSummary = {
  totals: Record<string, number>;
  daily: Array<{ day: string; views: number; clicks: number; downloads: number; shares: number }>;
  topLinks: Array<{ link_kind: string; link_url: string | null; count: number }>;
  recent: Array<{
    id: string;
    event_type: string;
    link_kind: string | null;
    link_url: string | null;
    referrer: string | null;
    created_at: string;
  }>;
  rangeDays: number;
};

/** Owner — summary analytics for their own card. */
export const getMyCardAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: any) =>
    z.object({ days: z.number().int().min(1).max(365).default(30) }).parse(d ?? {})
  )
  .handler(async ({ context, data }): Promise<CardAnalyticsSummary> => {
    const { userId } = context;
    const since = new Date(Date.now() - data.days * 86400_000).toISOString();

    const { data: rows } = await supabaseAdmin
      .from("card_events")
      .select("id, event_type, link_kind, link_url, referrer, created_at")
      .eq("owner_user_id", userId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5000);

    const events = rows ?? [];

    const totals: Record<string, number> = { view: 0, link_click: 0, vcard_download: 0, share: 0 };
    const byDay = new Map<string, { views: number; clicks: number; downloads: number; shares: number }>();
    const linkCounts = new Map<string, { link_kind: string; link_url: string | null; count: number }>();

    // Prefill days
    for (let i = data.days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      byDay.set(d, { views: 0, clicks: 0, downloads: 0, shares: 0 });
    }

    for (const e of events) {
      totals[e.event_type] = (totals[e.event_type] ?? 0) + 1;
      const day = e.created_at.slice(0, 10);
      const b = byDay.get(day) ?? { views: 0, clicks: 0, downloads: 0, shares: 0 };
      if (e.event_type === "view") b.views++;
      else if (e.event_type === "link_click") b.clicks++;
      else if (e.event_type === "vcard_download") b.downloads++;
      else if (e.event_type === "share") b.shares++;
      byDay.set(day, b);

      if (e.event_type === "link_click") {
        const key = `${e.link_kind ?? "other"}::${e.link_url ?? ""}`;
        const cur = linkCounts.get(key) ?? { link_kind: e.link_kind ?? "other", link_url: e.link_url, count: 0 };
        cur.count++;
        linkCounts.set(key, cur);
      }
    }

    const daily = Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, ...v }));

    const topLinks = Array.from(linkCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    return {
      totals,
      daily,
      topLinks,
      recent: events.slice(0, 25) as any,
      rangeDays: data.days,
    };
  });
