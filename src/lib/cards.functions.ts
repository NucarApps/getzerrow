import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildVCard, sendCardEmail, type CardData } from "./cards.server";
import { setContactEncryptedFields } from "./sync/encrypted-writer";

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,30}$/;

/** Normalize user-entered URLs: trim, return null if empty, prepend https:// if missing. */
function normalizeUrl(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}
function normalizeHttpsUrl(v: unknown): unknown {
  const n = normalizeUrl(v);
  if (typeof n !== "string") return n;
  return n.replace(/^http:\/\//i, "https://");
}

const urlField = z.preprocess(normalizeUrl, z.string().url().max(500).nullable().optional());
const httpsUrlField = z.preprocess(normalizeHttpsUrl, z.string().url().max(1000).nullable().optional());

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
      website: urlField,
      linkedin: urlField,
      twitter: urlField,
      avatar_url: httpsUrlField,
      cover_url: httpsUrlField,
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
      .select("handle,name,title,company,email,phone,website,linkedin,twitter,avatar_url,cover_url,tagline,theme")
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

/** Public — capture a lead from a public card. Creates a contact for the card owner. */
export const submitCardLead = createServerFn({ method: "POST" })
  .inputValidator((d: any) =>
    z.object({
      handle: z.string().regex(HANDLE_RE),
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().email().max(255),
      company: z.string().trim().max(160).optional().or(z.literal("")),
      phone: z.string().trim().max(60).optional().or(z.literal("")),
      message: z.string().trim().max(1000).optional().or(z.literal("")),
    }).parse(d)
  )
  .handler(async ({ data }) => {
    const handle = data.handle.toLowerCase();
    const { data: card } = await supabaseAdmin
      .from("my_cards")
      .select("id, user_id")
      .eq("handle", handle)
      .maybeSingle();
    if (!card) throw new Error("Card not found");

    const email = data.email.toLowerCase();
    const notes = data.message ? `Lead via /c/${handle}: ${data.message}` : `Lead via /c/${handle}`;

    // Upsert-style: if a contact already exists for this owner+email, append a note.
    const { data: existing } = await supabaseAdmin
      .from("contacts")
      .select("id, notes")
      .eq("user_id", card.user_id)
      .eq("email", email)
      .maybeSingle();

    if (existing) {
      const merged = existing.notes ? `${existing.notes}\n\n${notes}` : notes;
      await supabaseAdmin
        .from("contacts")
        .update({
          name: data.name,
          company: data.company || null,
          phone: data.phone || null,
          notes: merged,
          source: "card_lead",
        })
        .eq("id", existing.id);
      await setContactEncryptedFields({
        contact_id: existing.id,
        phone: data.phone || undefined,
        notes: merged,
      });
    } else {
      const { data: inserted } = await supabaseAdmin.from("contacts").insert({
        user_id: card.user_id,
        email,
        name: data.name,
        company: data.company || null,
        phone: data.phone || null,
        notes,
        source: "card_lead",
      }).select("id").single();
      if (inserted?.id) {
        await setContactEncryptedFields({
          contact_id: inserted.id,
          phone: data.phone || undefined,
          notes,
        });
      }
    }


    // Log analytics event (best-effort).
    await supabaseAdmin.from("card_events").insert({
      card_id: card.id,
      owner_user_id: card.user_id,
      handle,
      event_type: "lead",
    });

    return { ok: true };
  });
