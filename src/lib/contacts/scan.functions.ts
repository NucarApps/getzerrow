import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { generateText, Output } from "ai";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendContactShareEmail } from "../cards.server";
import { setContactEncryptedFields } from "../sync/encrypted-writer";
import {
  getContactDecrypted,
  getContactListFieldsDecrypted,
  getEmailsDecrypted,
} from "../sync/encrypted-reader";
import {
  fetchFromGmail,
  getModel,
  EXTRACT_SCHEMA,
  ADDRESS_FIELDS,
  isLikelyHuman,
  normalizeName,
  firstNameKey,
  pickBetterName,
  phoneEntrySchema,
} from "../contacts-helpers.server";

export const scanCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { imageDataUrl: string }) =>
    z
      .object({
        imageDataUrl: z
          .string()
          .min(64)
          .max(15_000_000)
          .regex(/^data:image\//, "Must be a data URL"),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
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
    type ScanOut = z.infer<typeof SCAN_SCHEMA>;

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

    async function tryStructured(modelId: string): Promise<ScanOut | null> {
      try {
        const { output } = await generateText({
          model: getModel(modelId),
          output: Output.object({ schema: SCAN_SCHEMA }),
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: baseInstruction },
                { type: "image", image: data.imageDataUrl },
              ],
            },
          ],
        });
        return output as ScanOut;
      } catch (e) {
        lastError = describeError(e);
        console.error(`scanCard structured failed (${modelId})`, lastError);
        return null;
      }
    }

    async function tryTextJson(modelId: string): Promise<ScanOut | null> {
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
                { type: "image", image: data.imageDataUrl },
              ],
            },
          ],
        });
        const cleaned = text
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/```\s*$/i, "");
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start < 0 || end <= start) {
          lastError = `empty/non-JSON response (len=${text.length})`;
          console.error(`scanCard text-json failed (${modelId})`, lastError);
          return null;
        }
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        return SCAN_SCHEMA.parse(parsed);
      } catch (e) {
        lastError = describeError(e);
        console.error(`scanCard text-json failed (${modelId})`, lastError);
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
    return { draft: output };
  });

/** Create a contact from a scanned-card draft. */
export const createContactFromScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        email: z.string().email(),
        name: z.string().max(200).nullable().optional(),
        title: z.string().max(200).nullable().optional(),
        company: z.string().max(200).nullable().optional(),
        phone: z.string().max(60).nullable().optional(),
        website: z.string().max(500).nullable().optional(),
        linkedin: z.string().max(500).nullable().optional(),
        twitter: z.string().max(500).nullable().optional(),
        address_line1: z.string().trim().max(200).nullable().optional(),
        address_line2: z.string().trim().max(200).nullable().optional(),
        city: z.string().trim().max(120).nullable().optional(),
        region: z.string().trim().max(120).nullable().optional(),
        postal_code: z.string().trim().max(40).nullable().optional(),
        country: z.string().trim().max(60).nullable().optional(),
        card_image_url: z
          .string()
          .max(500)
          .regex(/^[A-Za-z0-9_\-/.]+$/)
          .nullable()
          .optional(),
        phones: z.array(phoneEntrySchema).max(20).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const email = data.email.trim().toLowerCase();
    const { phones, phone: phoneFromData, address_line1, address_line2, ...rest } = data;
    // Derive primary phone from phones[] (if provided), else from `phone`.
    const primary = phones?.find((p) => p.is_primary) ?? phones?.[0];
    const primaryPhone = primary?.number?.trim() || phoneFromData || null;
    const plaintextPayload = {
      ...rest,
      name: normalizeName(rest.name ?? null),
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
    // Sensitive fields (phone, address lines) are encrypted-only after Phase 3.
    await setContactEncryptedFields({
      contact_id: row.id,
      phone: primaryPhone ?? undefined,
      notes: undefined,
      address_line1: address_line1 ?? undefined,
      address_line2: address_line2 ?? undefined,
    });

    if (phones && phones.length > 0) {
      // Replace any existing phones for this contact.
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
  });
export const getContactCardSignedUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ contactId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("contacts")
      .select("card_image_url,user_id")
      .eq("id", data.contactId)
      .single();
    if (error || !row) throw new Error("Contact not found");
    if (row.user_id !== userId) throw new Error("Forbidden");
    const path = row.card_image_url;
    if (!path) return { url: null as string | null };
    // Defensive: must live under the user's folder.
    if (!path.startsWith(`${userId}/`)) throw new Error("Invalid path");
    const { data: signed, error: sErr } = await supabaseAdmin.storage
      .from("contact-cards")
      .createSignedUrl(path, 60 * 10); // 10 minutes
    if (sErr || !signed) throw new Error(sErr?.message ?? "Could not sign URL");
    return { url: signed.signedUrl };
  });
