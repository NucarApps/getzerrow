// Server-only business-card scanning for the mobile companion API.
// Mirrors the web scanner in contacts.functions.ts EXACTLY — same models,
// same prompts, same fallback chain, same save semantics — so a card
// scanned on the phone produces identical results to the web's /contacts/scan.
// If you change the web scanner, change this file to match (and vice versa).
import { z } from "zod";
import { generateText, Output } from "ai";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getModel } from "./ai-gateway";
import { parseLenientJson } from "./ai-untrusted";
import { setContactEncryptedFields } from "./sync/encrypted-writer";

const SCAN_SCHEMA = z.object({
  name: z.string().nullable(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  linkedin: z.string().nullable(),
  twitter: z.string().nullable(),
  phones: z
    .array(
      z.object({
        label: z.string(),
        number: z.string(),
      }),
    )
    .nullable()
    .optional(),
  address_line1: z.string().nullable().optional(),
  address_line2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  postal_code: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
});

export type CardScanDraft = z.infer<typeof SCAN_SCHEMA>;

/** Extract draft contact fields from a business-card photo (data URL).
 *  Same AI chain as the web's scanCard: structured output first, plain-JSON
 *  fallback, then smaller/larger models. Throws when nothing parseable. */
export async function extractCardDraft(imageDataUrl: string): Promise<CardScanDraft> {
  const baseInstruction =
    'Extract contact information from this business card photo. Return each field exactly as printed or null if not visible. Do NOT invent values. If multiple phone numbers are present, list each one in `phones` with a label like "mobile", "work", "home", or "other" (lowercase). Still set `phone` to the most prominent / primary number. If a postal address is shown, split it into address_line1, address_line2, city, region (state/province), postal_code, and country.';
  const jsonShape =
    '{"name":<string|null>,"title":<string|null>,"company":<string|null>,"email":<string|null>,"phone":<string|null>,"website":<string|null>,"linkedin":<string|null>,"twitter":<string|null>,"phones":<[{"label":<string>,"number":<string>}]|null>,"address_line1":<string|null>,"address_line2":<string|null>,"city":<string|null>,"region":<string|null>,"postal_code":<string|null>,"country":<string|null>}';

  let lastError = "unknown error";

  function describeError(e: unknown): string {
    const err = e as { name?: string; status?: number; message?: string; responseBody?: unknown };
    const parts: string[] = [];
    if (err?.name) parts.push(err.name);
    if (typeof err?.status === "number") parts.push(`status=${err.status}`);
    if (err?.message) parts.push(err.message);
    if (err?.responseBody) parts.push(`body=${String(err.responseBody).slice(0, 200)}`);
    return parts.join(" | ").slice(0, 400) || "unknown error";
  }

  async function tryStructured(modelId: string): Promise<CardScanDraft | null> {
    try {
      const { output } = await generateText({
        model: getModel(modelId),
        output: Output.object({ schema: SCAN_SCHEMA }),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: baseInstruction },
              { type: "image", image: imageDataUrl },
            ],
          },
        ],
      });
      return output as CardScanDraft;
    } catch (e) {
      lastError = describeError(e);
      console.error(`mobile card scan structured failed (${modelId})`, lastError);
      return null;
    }
  }

  async function tryTextJson(modelId: string): Promise<CardScanDraft | null> {
    try {
      const { text } = await generateText({
        model: getModel(modelId),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${baseInstruction}\n\nRespond with ONLY a JSON object (no markdown, no prose, no code fences) of this exact shape:\n${jsonShape}`,
              },
              { type: "image", image: imageDataUrl },
            ],
          },
        ],
      });
      const parsed = parseLenientJson(text, SCAN_SCHEMA);
      if (parsed === null) {
        lastError = `empty/non-JSON response (len=${text.length})`;
        console.error(`mobile card scan text-json failed (${modelId})`, lastError);
        return null;
      }
      return parsed;
    } catch (e) {
      lastError = describeError(e);
      console.error(`mobile card scan text-json failed (${modelId})`, lastError);
      return null;
    }
  }

  const output =
    (await tryStructured("google/gemini-2.5-flash")) ||
    (await tryTextJson("google/gemini-2.5-flash")) ||
    (await tryStructured("google/gemini-2.5-flash-lite")) ||
    (await tryTextJson("google/gemini-2.5-flash-lite")) ||
    (await tryTextJson("google/gemini-2.5-pro"));

  if (!output) {
    throw new Error(
      `Couldn't read the card: AI vision returned no parseable response (last error: ${lastError})`,
    );
  }
  return output;
}

export type ScanPhoneEntry = {
  label: string;
  number: string;
  is_primary?: boolean;
};

export type ScanContactInput = {
  email: string;
  name?: string | null;
  title?: string | null;
  company?: string | null;
  phone?: string | null;
  website?: string | null;
  linkedin?: string | null;
  twitter?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
  card_image_url?: string | null;
  phones?: ScanPhoneEntry[];
};

/** Normalize a contact display name to "First Last" form — a copy of
 *  contacts.functions.ts normalizeName (kept here to stay server-only). */
function normalizeScannedName(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim();
  s = s.replace(/^["'`<\s]+|["'`>\s]+$/g, "");
  s = s.replace(/\s*[([][^)\]]*[)\]]\s*$/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/@/.test(s) && /\.[a-z]{2,}$/i.test(s)) return null;

  const commaCount = (s.match(/,/g) ?? []).length;
  if (commaCount === 1) {
    const [last, rest] = s.split(",").map((x) => x.trim());
    if (last && rest && /^[\p{L}'’\-. ]+$/u.test(last) && /^[\p{L}'’\-. ]+$/u.test(rest)) {
      s = `${rest} ${last}`.replace(/\s+/g, " ").trim();
    }
  }

  const isAllCaps = s === s.toUpperCase() && /[A-Z]/.test(s);
  const isAllLower = s === s.toLowerCase() && /[a-z]/.test(s);
  if (isAllCaps || isAllLower) {
    s = s
      .toLowerCase()
      .split(" ")
      .map((tok) =>
        tok
          .split("-")
          .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
          .join("-"),
      )
      .join(" ");
  }

  return s || null;
}

/** Save a reviewed scan draft as a contact — the same path as the web's
 *  createContactFromScan: upsert on user+email (no duplicates), sensitive
 *  fields written only through the encrypted RPC, phones replaced in full. */
export async function saveScannedContact(userId: string, data: ScanContactInput) {
  const email = data.email.trim().toLowerCase();
  const { phones, phone: phoneFromData, address_line1, address_line2, ...rest } = data;
  const primary = phones?.find((p) => p.is_primary) ?? phones?.[0];
  const primaryPhone = primary?.number?.trim() || phoneFromData || null;
  const plaintextPayload = {
    ...rest,
    name: normalizeScannedName(rest.name ?? null),
  };
  const { data: row, error } = await supabaseAdmin
    .from("contacts")
    .upsert(
      {
        user_id: userId,
        ...plaintextPayload,
        email,
        source: "scan",
        enriched_at: new Date().toISOString(),
      },
      { onConflict: "user_id,email" },
    )
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  await setContactEncryptedFields({
    contact_id: row.id,
    phone: primaryPhone ?? undefined,
    notes: undefined,
    address_line1: address_line1 ?? undefined,
    address_line2: address_line2 ?? undefined,
  });

  if (phones && phones.length > 0) {
    await supabaseAdmin.from("contact_phones").delete().eq("contact_id", row.id);
    const hasPrimary = phones.some((p) => p.is_primary);
    const normalized = phones.map((p, idx) => ({
      user_id: userId,
      contact_id: row.id,
      label: p.label.trim().toLowerCase(),
      number: p.number.trim(),
      is_primary: hasPrimary ? !!p.is_primary : idx === 0,
      position: idx,
    }));
    const { error: insErr } = await supabaseAdmin.from("contact_phones").insert(normalized);
    if (insErr) throw new Error(insErr.message);
  }
  return { contact: row };
}
