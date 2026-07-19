// Shared helper: flip google_contact_links.last_synced_at to a sentinel
// timestamp so the next push cycle treats the linked contact as dirty.
// Used from every code path that changes a locally-held field Google needs
// to see (photo uploads/removals, company-logo resets, company-logo swaps).
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const GOOGLE_SYNC_DIRTY_SENTINEL = "1970-01-01T00:00:00.000Z";

export async function markGoogleContactDirty(
  userId: string,
  contactId: string,
): Promise<void> {
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
