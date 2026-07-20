// Shared helper: flip google_contact_links.last_synced_at to a sentinel
// timestamp so the next push cycle treats the linked contact as dirty.
// Used from every code path that changes a locally-held field Google needs
// to see (photo uploads/removals, company-logo resets, company-logo swaps).
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const GOOGLE_SYNC_DIRTY_SENTINEL = "1970-01-01T00:00:00.000Z";

export async function markGoogleContactDirty(userId: string, contactId: string): Promise<void> {
  await supabaseAdmin
    .from("google_contact_links")
    .update({ last_synced_at: GOOGLE_SYNC_DIRTY_SENTINEL })
    .eq("user_id", userId)
    .eq("contact_id", contactId);
}

export async function markGoogleContactsDirty(
  userId: string,
  contactIds: readonly string[],
): Promise<void> {
  if (contactIds.length === 0) return;
  await supabaseAdmin
    .from("google_contact_links")
    .update({ last_synced_at: GOOGLE_SYNC_DIRTY_SENTINEL })
    .eq("user_id", userId)
    .in("contact_id", contactIds);
}

/** Flag a contact's photo as needing another push attempt. Clears the
 *  push identifier and resets the retry counter so the push loop tries
 *  again after transient failures (Google rate limit / auth blip) that
 *  would otherwise cap out at MAX_PHOTO_PUSH_ATTEMPTS forever. Body
 *  dirtiness is deliberately left alone — the photo push runs on its own
 *  endpoint and doesn't need a matching body write. */
export async function markGooglePhotoDirty(userId: string, contactId: string): Promise<void> {
  await supabaseAdmin
    .from("google_contact_links")
    .update({ photo_etag: null, photo_push_attempts: 0 })
    .eq("user_id", userId)
    .eq("contact_id", contactId);
}

export async function markGooglePhotoDirtyMany(
  userId: string,
  contactIds: readonly string[],
): Promise<void> {
  if (contactIds.length === 0) return;
  await supabaseAdmin
    .from("google_contact_links")
    .update({ photo_etag: null, photo_push_attempts: 0 })
    .eq("user_id", userId)
    .in("contact_id", contactIds);
}
