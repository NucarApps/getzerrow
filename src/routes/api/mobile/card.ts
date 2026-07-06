// Mobile API — the signed-in user's shareable contact card.
// GET  /api/mobile/card  -> { card }
// POST /api/mobile/card  { handle, name?, title?, ... } -> { card }
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { authenticateRequest } from "@/lib/mobile-auth.server";

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,30}$/;

function normalizeUrl(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

const urlField = z.preprocess(normalizeUrl, z.string().url().max(1000).nullable().optional());

const cardSchema = z.object({
  handle: z.string().regex(HANDLE_RE, "3-31 chars, lowercase letters/numbers/dashes"),
  name: z.string().max(200).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  website: urlField,
  linkedin: urlField,
  twitter: urlField,
  avatar_url: urlField,
  cover_url: urlField,
  tagline: z.string().max(280).nullable().optional(),
  theme: z.string().max(40).optional(),
});

export const Route = createFileRoute("/api/mobile/card")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { supabase } = await authenticateRequest(request);
          const { data } = await supabase.from("my_cards").select("*").maybeSingle();
          return Response.json({ card: data ?? null });
        } catch (r) {
          if (r instanceof Response) return r;
          return new Response("Unauthorized", { status: 401 });
        }
      },
      POST: async ({ request }) => {
        let userId: string;
        let supabase: Awaited<ReturnType<typeof authenticateRequest>>["supabase"];
        try {
          ({ userId, supabase } = await authenticateRequest(request));
        } catch (r) {
          if (r instanceof Response) return r;
          return new Response("Unauthorized", { status: 401 });
        }

        let body: z.infer<typeof cardSchema>;
        try {
          body = cardSchema.parse(await request.json());
        } catch {
          return new Response("Invalid card data", { status: 400 });
        }

        const handle = body.handle.toLowerCase();

        // Ensure the handle isn't taken by another user (admin read bypasses RLS).
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: existing } = await supabaseAdmin
          .from("my_cards")
          .select("user_id")
          .eq("handle", handle)
          .maybeSingle();
        if (existing && existing.user_id !== userId) {
          return Response.json(
            { ok: false, error: "That handle is already taken — try another." },
            { status: 409 },
          );
        }

        const { data: card, error } = await supabase
          .from("my_cards")
          .upsert({ user_id: userId, ...body, handle }, { onConflict: "user_id" })
          .select("*")
          .single();
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 400 });
        }
        return Response.json({ ok: true, card });
      },
    },
  },
});
