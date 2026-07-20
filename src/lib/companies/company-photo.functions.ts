// Server fns for a company's custom uploaded logo. The client posts raw image
// bytes as base64 (same-origin). We validate ownership + size, save to the
// public company-logos bucket, bump the CardDAV resync nonce so iPhones pull
// the new logo, and mark the company's Google-linked contacts dirty so the
// next two-way sync repushes it.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function assertOwnsCompany(userId: string, companyId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new Error("Company not found");
}

/** Nudge Google sync to repush the logo for every contact linked to this
 *  company, so the change reaches Google People too (best-effort). Also
 *  resets each contact's photo retry counter so any previous "gave up" state
 *  doesn't keep the sync from trying again after the logo swap. */
async function markCompanyContactsDirty(userId: string, companyId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { markGoogleContactsDirty, markGooglePhotoDirtyMany } =
    await import("@/lib/google-contacts/mark-dirty.server");
  const { data: contacts } = await supabaseAdmin
    .from("contacts")
    .select("id")
    .eq("user_id", userId)
    .eq("company_id", companyId);
  const ids = (contacts ?? []).map((c) => (c as { id: string }).id);
  await markGoogleContactsDirty(userId, ids);
  await markGooglePhotoDirtyMany(userId, ids);
}

export const uploadCompanyPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        companyId: z.string().uuid(),
        base64: z.string().min(1),
        mime: z.enum(ALLOWED_MIME),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertOwnsCompany(context.userId, data.companyId);
    const bytes = base64ToBytes(data.base64);
    if (bytes.length === 0) throw new Error("Empty upload");
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("Image too large (max 5 MB)");

    const { saveCompanyPhoto } = await import("./company-photo.server");
    const { logoUrl } = await saveCompanyPhoto(context.userId, data.companyId, bytes, data.mime);

    const { supabase } = context;
    const { bumpResyncNonce } = await import("@/lib/carddav/settings.functions");
    try {
      await bumpResyncNonce(supabase, context.userId);
    } catch {
      // Non-fatal.
    }
    try {
      await markCompanyContactsDirty(context.userId, data.companyId);
    } catch {
      // Not linked to Google — no-op.
    }
    return { logoUrl };
  });

export const removeCompanyPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ companyId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsCompany(context.userId, data.companyId);
    const { deleteCompanyPhoto } = await import("./company-photo.server");
    await deleteCompanyPhoto(context.userId, data.companyId);

    const { supabase } = context;
    const { bumpResyncNonce } = await import("@/lib/carddav/settings.functions");
    try {
      await bumpResyncNonce(supabase, context.userId);
    } catch {
      // Non-fatal.
    }
    try {
      await markCompanyContactsDirty(context.userId, data.companyId);
    } catch {
      // Non-fatal.
    }
    return { ok: true as const };
  });
