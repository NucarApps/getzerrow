// Typed wrappers around the dual-write encryption RPCs. All ingest /
// classify / forward / contact / reply-draft writes that touch sensitive
// columns go through here so the encryption key (process.env.EMAIL_ENC_KEY)
// is never spread across the codebase.
//
// Phase 2 = dual-write: the RPCs populate BOTH plaintext and `*_enc`
// columns. Phase 3 will stop writing plaintext and drop those columns.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

function getKey(): string {
  const key = process.env.EMAIL_ENC_KEY;
  if (!key) throw new Error("EMAIL_ENC_KEY not configured");
  return key;
}

export type UpsertEmailInput = {
  user_id: string;
  gmail_account_id: string;
  gmail_message_id: string;
  thread_id: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_addrs: string | null;
  cc: string | null;
  list_id: string | null;
  in_reply_to: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  received_at: string | null;
  is_read: boolean;
  is_archived: boolean;
  has_attachment: boolean;
  raw_labels: string[] | null;
  classified_by: string;
  processed_at: string | null;
  published_at_ms: number | null;
};

export async function upsertEmailEncrypted(input: UpsertEmailInput): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await supabaseAdmin.rpc("upsert_email_encrypted", {
    p_user_id: input.user_id,
    p_gmail_account_id: input.gmail_account_id,
    p_gmail_message_id: input.gmail_message_id,
    p_thread_id: input.thread_id,
    p_from_addr: input.from_addr,
    p_from_name: input.from_name,
    p_to_addrs: input.to_addrs,
    p_cc: input.cc,
    p_list_id: input.list_id,
    p_in_reply_to: input.in_reply_to,
    p_subject: input.subject,
    p_snippet: input.snippet,
    p_body_text: input.body_text,
    p_body_html: input.body_html,
    p_received_at: input.received_at,
    p_is_read: input.is_read,
    p_is_archived: input.is_archived,
    p_has_attachment: input.has_attachment,
    p_raw_labels: input.raw_labels,
    p_classified_by: input.classified_by,
    p_processed_at: input.processed_at,
    p_published_at_ms: input.published_at_ms,
    p_key: getKey(),
  });
  if (error) return { id: null, error: error.message };
  return { id: (data as string | null) ?? null, error: null };
}

export type UpdateEmailInput = {
  email_id: string;
  // Pass null/undefined to leave the column unchanged.
  subject?: string | null;
  snippet?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  ai_summary?: string | null;
  classification_reason?: string | null;
  from_name?: string | null;
  to_addrs?: string | null;
  folder_id?: string | null;
  ai_confidence?: number | null;
  classified_by?: string | null;
  matched_filter_ids?: string[] | null;
  matched_folder_ids?: string[] | null;
};

export async function updateEmailEncrypted(input: UpdateEmailInput): Promise<{ error: string | null }> {
  const { error } = await supabaseAdmin.rpc("update_email_encrypted", {
    p_email_id: input.email_id,
    p_subject: input.subject ?? null,
    p_snippet: input.snippet ?? null,
    p_body_text: input.body_text ?? null,
    p_body_html: input.body_html ?? null,
    p_ai_summary: input.ai_summary ?? null,
    p_classification_reason: input.classification_reason ?? null,
    p_from_name: input.from_name ?? null,
    p_to_addrs: input.to_addrs ?? null,
    p_folder_id: input.folder_id ?? null,
    p_ai_confidence: input.ai_confidence ?? null,
    p_classified_by: input.classified_by ?? null,
    p_matched_filter_ids: input.matched_filter_ids ?? null,
    p_matched_folder_ids: input.matched_folder_ids ?? null,
    p_key: getKey(),
  });
  return { error: error?.message ?? null };
}

export async function setReplyDraftEncrypted(input: {
  user_id: string;
  email_id: string;
  draft_text: string;
}): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await supabaseAdmin.rpc("set_reply_draft_encrypted", {
    p_user_id: input.user_id,
    p_email_id: input.email_id,
    p_draft_text: input.draft_text,
    p_key: getKey(),
  });
  if (error) return { id: null, error: error.message };
  return { id: (data as string | null) ?? null, error: null };
}

export async function setContactEncryptedFields(input: {
  contact_id: string;
  notes?: string | null;
  relationship_summary?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  phone?: string | null;
}): Promise<{ error: string | null }> {
  const { error } = await supabaseAdmin.rpc("set_contact_encrypted_fields", {
    p_contact_id: input.contact_id,
    p_notes: input.notes ?? null,
    p_relationship_summary: input.relationship_summary ?? null,
    p_address_line1: input.address_line1 ?? null,
    p_address_line2: input.address_line2 ?? null,
    p_phone: input.phone ?? null,
    p_key: getKey(),
  });
  return { error: error?.message ?? null };
}

export async function insertFolderExampleEncrypted(input: {
  user_id: string;
  gmail_account_id: string;
  folder_id: string;
  gmail_message_id: string;
  from_addr: string | null;
  subject: string | null;
  snippet: string | null;
  source?: string | null;
}): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await supabaseAdmin.rpc("insert_folder_example_encrypted", {
    p_user_id: input.user_id,
    p_gmail_account_id: input.gmail_account_id,
    p_folder_id: input.folder_id,
    p_gmail_message_id: input.gmail_message_id,
    p_from_addr: input.from_addr,
    p_subject: input.subject,
    p_snippet: input.snippet,
    p_source: input.source ?? "seed",
    p_key: getKey(),
  });
  if (error) return { id: null, error: error.message };
  return { id: (data as string | null) ?? null, error: null };
}
