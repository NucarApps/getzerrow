import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { phoneEntrySchema } from "../contacts-helpers.server";
import { extractCardDraft, saveScannedContact } from "@/lib/card-scan.server";

export const scanCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { imageDataUrl: string }) =>
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
    // Same extraction the mobile API uses — one implementation, one prompt,
    // one model cascade. The label only changes the log prefix.
    return { draft: await extractCardDraft(data.imageDataUrl, "scanCard") };
  });

/** Create a contact from a scanned-card draft. */
export const createContactFromScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) =>
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
    // Byte-identical to the mobile save path before this; now literally it.
    return saveScannedContact(context.userId, data);
  });
export const getContactCardSignedUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => z.object({ contactId: z.string().uuid() }).parse(d))
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
