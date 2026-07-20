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
    const { avatarUrl } = await saveContactPhoto(
      context.userId,
      data.contactId,
      bytes,
      data.mime,
      "user_upload",
    );

    // Nudge Google sync to push the new picture upstream on next run.
    // A brand-new local photo also resets the retry budget so any previous
    // "gave up" state doesn't keep the sync from trying again.
    try {
      const { markGoogleContactDirty, markGooglePhotoDirty } =
        await import("@/lib/google-contacts/mark-dirty.server");
      await markGoogleContactDirty(context.userId, data.contactId);
      await markGooglePhotoDirty(context.userId, data.contactId);
    } catch {
      // Not linked to Google — no-op.
    }

    // Bump the CardDAV resync nonce so iOS pulls the new picture on next
    // sync. The CardDAV serve path already honors the effective photo
    // priority (contact override → company → global default) via
    // getEffectivePhotoPriority, so iOS sees personal vs company per the
    // user's configured preference — no override forced here.
    try {
      const { bumpResyncNonce } = await import("@/lib/carddav/settings.functions");
      await bumpResyncNonce(context.supabase, context.userId);
      const { logInfo } = await import("@/lib/log.server");
      logInfo("carddav.resync_nonce_bumped", {
        user_id: context.userId,
        contact_id: data.contactId,
        reason: "photo_upload",
      });
    } catch {
      // Non-fatal — the next scheduled sync will still pick it up.
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
      const { markGoogleContactDirty, markGooglePhotoDirty } =
        await import("@/lib/google-contacts/mark-dirty.server");
      await markGoogleContactDirty(context.userId, data.contactId);
      await markGooglePhotoDirty(context.userId, data.contactId);
    } catch {
      // ignore
    }

    // Push removal to iOS on next sync — same lever as upload.
    try {
      const { bumpResyncNonce } = await import("@/lib/carddav/settings.functions");
      await bumpResyncNonce(context.supabase, context.userId);
      const { logInfo } = await import("@/lib/log.server");
      logInfo("carddav.resync_nonce_bumped", {
        user_id: context.userId,
        contact_id: data.contactId,
        reason: "photo_remove",
      });
    } catch {
      // Non-fatal.
    }

    return { ok: true };
  });

/** Mint a short-lived signed URL for a contact's stored photo. The bucket is
 * private, so the browser can't hit `avatar_url` directly — call this after
 * verifying the caller owns the contact. Returns `{ url: null }` when the
 * contact has no stored photo. */
export const getContactPhotoSignedUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ contactId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<{ url: string | null }> => {
    await assertOwnsContact(context.userId, data.contactId);
    const { signContactPhotoUrl } = await import("@/lib/contacts/photos.server");
    const url = await signContactPhotoUrl(context.userId, data.contactId);
    return { url };
  });
