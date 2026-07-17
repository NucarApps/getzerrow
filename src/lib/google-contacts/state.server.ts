// Shared helpers for the Google Contacts sync module. Server-only.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getContactDecrypted } from "@/lib/sync/encrypted-reader";
import type { LocalContact } from "./mapper";

export type SyncState = {
  id: string;
  user_id: string;
  gmail_account_id: string;
  enabled: boolean;
  sync_mode: "off" | "pull_only" | "two_way";
  people_sync_token: string | null;
  groups_sync_token: string | null;
  last_full_sync_at: string | null;
  last_incremental_at: string | null;
  last_error: string | null;
  last_pull_count: number;
  last_push_count: number;
  pending_bump: boolean;
  locked_at: string | null;
  progress_step: string | null;
  progress_processed: number;
  progress_total: number;
  progress_updated_at: string | null;
};

export async function loadSyncState(
  userId: string,
  gmailAccountId: string,
): Promise<SyncState | null> {
  const { data } = await supabaseAdmin
    .from("google_sync_state")
    .select("*")
    .eq("user_id", userId)
    .eq("gmail_account_id", gmailAccountId)
    .maybeSingle();
  return (data as SyncState | null) ?? null;
}

export async function ensureSyncState(
  userId: string,
  gmailAccountId: string,
  patch: Partial<SyncState> = {},
): Promise<SyncState> {
  const existing = await loadSyncState(userId, gmailAccountId);
  if (existing) return existing;
  const { data, error } = await supabaseAdmin
    .from("google_sync_state")
    .insert({ user_id: userId, gmail_account_id: gmailAccountId, ...patch })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to init google_sync_state: ${error.message}`);
  return data as SyncState;
}

export async function updateSyncState(
  id: string,
  patch: Partial<SyncState>,
): Promise<void> {
  const { error } = await supabaseAdmin.from("google_sync_state").update(patch).eq("id", id);
  if (error) throw new Error(`Failed to update google_sync_state: ${error.message}`);
}

/** Load a Zerrow contact in the shape the mapper expects (decrypted). */
export async function loadLocalContact(contactId: string): Promise<LocalContact | null> {
  const { row } = await getContactDecrypted(contactId);
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    title: row.title,
    company: row.company,
    website: row.website,
    linkedin: row.linkedin,
    twitter: row.twitter,
    address_line1: row.address_line1,
    address_line2: row.address_line2,
    city: row.city,
    region: row.region,
    postal_code: row.postal_code,
    country: row.country,
    notes: row.notes,
    primary_phone: row.phone,
  };
}
