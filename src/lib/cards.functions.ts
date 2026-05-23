import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildVCard, sendCardEmail, type CardData } from "./cards.server";

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,30}$/;

/** Get the signed-in user's own card (or null if not set yet). */
export const getMyCard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data } = await supabase.from("my_cards").select("*").maybeSingle();
    return { card: data };
  });

/** Create or update the signed-in user's card. */
export const upsertMyCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: any) =>
    z.object({
      handle: z.string().regex(HANDLE_RE, "3-31 chars, lowercase letters/numbers/dashes, must start alphanumeric"),
      name: z.string().max(200).nullable().optional(),
      title: z.string().max(200).nullable().optional(),
      company: z.string().max(200).nullable().optional(),
      email: z.string().email().nullable().optional(),
      phone: z.string().max(60).nullable().optional(),
      website: z.string().max(500).nullable().optional(),
      linkedin: z.string().max(500).nullable().optional(),
      twitter: z.string().max(500).nullable().optional(),
      avatar_url: z.string().max(1000).nullable().optional(),
      cover_url: z.string().max(1000).nullable().optional(),
      tagline: z.string().max(280).nullable().optional(),
      theme: z.string().max(40).optional(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const handle = data.handle.toLowerCase();

    // Ensure handle is not taken by another user.
    const { data: existing } = await supabaseAdmin
      .from("my_cards")
      .select("user_id")
      .eq("handle", handle)
      .maybeSingle();
    if (existing && existing.user_id !== userId) {
      throw new Error("That handle is already taken — try another.");
    }

    const { data: row, error } = await supabaseAdmin
      .from("my_cards")
      .upsert({ user_id: userId, ...data, handle }, { onConflict: "user_id" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { card: row };
  });

/** Public — fetch a card by handle. Safe-column projection. No auth. */
export const getPublicCard = createServerFn({ method: "GET" })
  .inputValidator((d: { handle: string }) =>
    z.object({ handle: z.string().regex(HANDLE_RE) }).parse(d)
  )
  .handler(async ({ data }) => {
    const { data: card } = await supabaseAdmin
      .from("my_cards")
      .select("handle,name,title,company,email,phone,website,linkedin,twitter,avatar_url,tagline,theme")
      .eq("handle", data.handle.toLowerCase())
      .maybeSingle();
    if (!card) return { card: null };
    return { card };
  });

/** Public — return a vCard text body for a handle. */
export const getPublicVCard = createServerFn({ method: "GET" })
  .inputValidator((d: { handle: string; publicUrl?: string }) =>
    z.object({
      handle: z.string().regex(HANDLE_RE),
      publicUrl: z.string().max(500).optional(),
    }).parse(d)
  )
  .handler(async ({ data }) => {
    const { data: card } = await supabaseAdmin
      .from("my_cards")
      .select("handle,name,title,company,email,phone,website,linkedin,twitter,tagline")
      .eq("handle", data.handle.toLowerCase())
      .maybeSingle();
    if (!card) throw new Error("Card not found");
    return { vcard: buildVCard(card as CardData, data.publicUrl) };
  });

/** Send the user's card to an email via their Gmail account. */
export const sendMyCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { toEmail: string; contactId?: string; publicBaseUrl: string }) =>
    z.object({
      toEmail: z.string().email(),
      contactId: z.string().uuid().optional(),
      publicBaseUrl: z.string().url(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context;

    const { data: card } = await supabase.from("my_cards").select("*").maybeSingle();
    if (!card) throw new Error("Set up your card first at /my-card");

    const { data: account } = await supabaseAdmin
      .from("gmail_accounts")
      .select("id, email_address")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!account) throw new Error("Connect your Gmail account in Settings first.");

    const publicUrl = `${data.publicBaseUrl.replace(/\/$/, "")}/c/${card.handle}`;

    await sendCardEmail({
      accountId: account.id,
      fromEmail: account.email_address,
      toEmail: data.toEmail,
      card: card as CardData,
      publicUrl,
    });

    await supabaseAdmin.from("contact_cards_sent").insert({
      user_id: userId,
      contact_id: data.contactId ?? null,
      to_email: data.toEmail.toLowerCase(),
    });

    return { ok: true };
  });
