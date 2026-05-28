// Server-only helpers that wrap the SECURITY DEFINER decrypt RPCs.
// All reads of sensitive plaintext fields (email bodies, AI summaries,
// classification reasons, reply drafts, contact PII) go through here so
// the EMAIL_ENC_KEY is held in exactly one place and the column-drop
// migration (Phase 3b) can land without leaking plaintext SELECTs.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

function getKey(): string {
  const key = process.env.EMAIL_ENC_KEY;
  if (!key) throw new Error("EMAIL_ENC_KEY not configured");
  return key;
}

export type DecryptedEmail = {
  id: string;
  user_id: string;
  gmail_account_id: string;
  gmail_message_id: string;
  thread_id: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_addrs: string | null;
  cc: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  ai_summary: string | null;
  classification_reason: string | null;
  classified_by: string | null;
  ai_confidence: number | null;
  received_at: string | null;
  is_read: boolean;
  is_archived: boolean;
  has_attachment: boolean;
  raw_labels: string[] | null;
  folder_id: string | null;
  matched_filter_ids: string[];
  matched_folder_ids: string[];
  snoozed_until: string | null;
  forwarded_to: string | null;
  forwarded_at: string | null;
  list_id: string | null;
  in_reply_to: string | null;
  published_at_ms: number | null;
  processed_at: string | null;
  created_at: string;
};

export async function getEmailsDecrypted(
  ids: string[],
): Promise<{ rows: DecryptedEmail[]; error: string | null }> {
  if (ids.length === 0) return { rows: [], error: null };
  const { data, error } = await supabaseAdmin.rpc("get_emails_decrypted", ({
    p_ids: ids,
    p_key: getKey(),
  }) as never);
  if (error) return { rows: [], error: error.message };
  return { rows: (data as DecryptedEmail[] | null) ?? [], error: null };
}

export type DecryptedContact = {
  id: string;
  notes: string | null;
  relationship_summary: string | null;
  address_line1: string | null;
  address_line2: string | null;
  phone: string | null;
};

export async function getContactDecrypted(
  contactId: string,
): Promise<{ row: DecryptedContact | null; error: string | null }> {
  const { data, error } = await supabaseAdmin.rpc("get_contact_decrypted", ({
    p_contact_id: contactId,
    p_key: getKey(),
  }) as never);
  if (error) return { row: null, error: error.message };
  const rows = (data as DecryptedContact[] | null) ?? [];
  return { row: rows[0] ?? null, error: null };
}

export async function getReplyDraftDecrypted(
  emailId: string,
): Promise<{ draft_text: string | null; error: string | null }> {
  const { data, error } = await supabaseAdmin.rpc("get_reply_draft_decrypted", ({
    p_email_id: emailId,
    p_key: getKey(),
  }) as never);
  if (error) return { draft_text: null, error: error.message };
  const rows = (data as Array<{ draft_text: string | null }> | null) ?? [];
  return { draft_text: rows[0]?.draft_text ?? null, error: null };
}

// Batch decrypt of the small AI-derived fields shown on inbox list rows.
// Returns only id + the two fields so payloads stay tiny for big folders.
export type EmailListFields = {
  id: string;
  ai_summary: string | null;
  classification_reason: string | null;
};

export async function getEmailListFieldsDecrypted(
  ids: string[],
): Promise<{ rows: EmailListFields[]; error: string | null }> {
  if (ids.length === 0) return { rows: [], error: null };
  const { data, error } = await supabaseAdmin.rpc("get_emails_list_fields_decrypted", ({
    p_ids: ids,
    p_key: getKey(),
  }) as never);
  if (error) return { rows: [], error: error.message };
  return { rows: (data as EmailListFields[] | null) ?? [], error: null };
}

export type ContactListFields = {
  id: string;
  relationship_summary: string | null;
  phone: string | null;
};

export async function getContactListFieldsDecrypted(
  ids: string[],
): Promise<{ rows: ContactListFields[]; error: string | null }> {
  if (ids.length === 0) return { rows: [], error: null };
  const { data, error } = await supabaseAdmin.rpc("get_contacts_list_fields_decrypted", ({
    p_ids: ids,
    p_key: getKey(),
  }) as never);
  if (error) return { rows: [], error: error.message };
  return { rows: (data as ContactListFields[] | null) ?? [], error: null };
}

export type ForwardRetryClaim = {
  id: string;
  gmail_account_id: string;
  gmail_message_id: string;
  folder_id: string | null;
  subject: string | null;
  from_addr: string | null;
  from_name: string | null;
  body_text: string | null;
  snippet: string | null;
  received_at: string | null;
  forward_attempts: number;
};

export async function claimForwardRetriesDecrypted(
  limit: number,
): Promise<{ rows: ForwardRetryClaim[]; error: string | null }> {
  const { data, error } = await supabaseAdmin.rpc("claim_forward_retries_v2", ({
    p_limit: limit,
    p_key: getKey(),
  }) as never);
  if (error) return { rows: [], error: error.message };
  return { rows: (data as ForwardRetryClaim[] | null) ?? [], error: null };
}
