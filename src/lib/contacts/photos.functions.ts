// Server fns for contact photo upload/remove. The client posts the raw image
// bytes as base64 (server functions are same-origin, so we don't need FormData
// or the storage-signed-upload dance). We validate ownership + size, save to
// the private helper, and mark any linked Google contact dirty so the next
// two-way sync uploads the picture to Google as well.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
const GOOGLE_SYNC_DIRTY_SENTINEL = "1970-01-01T00:00:00.000Z";

async function markGoogleContactDirty(userId: string, contactId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin
    .from("google_contact_links")
    .update({ last_synced_at: GOOGLE_SYNC_DIRTY_SENTINEL })
    .eq("user_id", userId)
    .eq("contact_id", contactId);
}

async function assertOwnsContact(userId: string, contactId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new Error("Contact not found");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const uploadContactPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        contactId: z.string().uuid(),
        base64: z.string().min(1),
        mime: z.enum(ALLOWED_MIME),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertOwnsContact(context.userId, data.contactId);
    const bytes = base64ToBytes(data.base64);
    if (bytes.length === 0) throw new Error("Empty upload");
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("Image too large (max 5 MB)");

    const { saveContactPhoto } = await import("@/lib/contacts/photos.server");
    const { avatarUrl } = await saveContactPhoto(context.userId, data.contactId, bytes, data.mime);

    // Nudge Google sync to push the new picture upstream on next run.
    try {
      const { markGoogleContactLinkDirty } = await import("@/lib/google-contacts/dirty");
      await markGoogleContactLinkDirty(context.userId, data.contactId);
    } catch {
      // Not linked to Google — no-op.
    }
    return { avatarUrl };
  });

export const removeContactPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ contactId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsContact(context.userId, data.contactId);
    const { deleteContactPhoto } = await import("@/lib/contacts/photos.server");
    await deleteContactPhoto(context.userId, data.contactId);
    try {
      const { markGoogleContactLinkDirty } = await import("@/lib/google-contacts/dirty");
      await markGoogleContactLinkDirty(context.userId, data.contactId);
    } catch {
      // ignore
    }
    return { ok: true };
  });
