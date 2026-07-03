// Typed wrappers around the dual-write encryption RPCs. All ingest /
// classify / forward / contact / reply-draft writes that touch sensitive
// columns go through here so the encryption key (process.env.EMAIL_ENC_KEY)
// is never spread across the codebase.
//
// Phase 2 = dual-write: the RPCs populate BOTH plaintext and `*_enc`
// columns. Phase 3 will stop writing plaintext and drop those columns.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo, logMetric } from "@/lib/log.server";
import {
  backoffDelayMs,
  isTransientWriteError,
  resolveRetryConfig,
  sleep,
} from "@/lib/folder-write-retry";


/** Postgres SQLSTATE from a Supabase RPC error, if present (e.g. "42703"). */
function pgErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

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

export async function upsertEmailEncrypted(
  input: UpsertEmailInput,
): Promise<{ id: string | null; error: string | null }> {
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
  } as never);
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

export async function updateEmailEncrypted(
  input: UpdateEmailInput,
): Promise<{ error: string | null }> {
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
  } as never);
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
  } as never);
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
  } as never);
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
  const source = input.source ?? "seed";
  const t0 = Date.now();

  // IDEMPOTENCY / DEDUPLICATION
  // ---------------------------
  // (folder_id, gmail_message_id) is the idempotency key for a folder example:
  // `folder_examples` has a UNIQUE(folder_id, gmail_message_id) constraint and
  // `insert_folder_example_encrypted` does `ON CONFLICT (folder_id,
  // gmail_message_id) DO UPDATE`. Every retry below re-sends the SAME natural
  // key, so a write that actually committed but returned a transient error
  // (e.g. a dropped connection after commit) is upserted in place on retry —
  // it can never create a duplicate encrypted example. No separate idempotency
  // token is needed because the logical identity of an example is fully
  // captured by (folder_id, gmail_message_id).
  //
  // Retry policy is read from the environment at call time so max attempts and
  // backoff base can be tuned without a redeploy (see resolveRetryConfig).
  const { maxAttempts, baseMs } = resolveRetryConfig();
  let data: unknown = null;
  let error: { message: string; code?: string } | null = null;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt++;
    const res = await supabaseAdmin.rpc("insert_folder_example_encrypted", {
      p_user_id: input.user_id,
      p_gmail_account_id: input.gmail_account_id,
      p_folder_id: input.folder_id,
      p_gmail_message_id: input.gmail_message_id,
      p_from_addr: input.from_addr,
      p_subject: input.subject,
      p_snippet: input.snippet,
      p_source: source,
      p_key: getKey(),
    } as never);
    data = res.data;
    error = res.error;
    if (!error) break;
    if (attempt >= maxAttempts || !isTransientWriteError(error)) break;
    const delayMs = backoffDelayMs(attempt, { baseMs });
    logInfo("folder_example_write.retry", {
      folder_id: input.folder_id,
      gmail_account_id: input.gmail_account_id,
      source,
      error_code: pgErrorCode(error),
      attempt,
      next_delay_ms: delayMs,
    });
    await sleep(delayMs);
  }

  // Metadata-only observability (no email content) so we can alert the moment
  // folder learning stops persisting examples again. See log.server.logMetric.
  const dims = {
    folder_id: input.folder_id,
    gmail_account_id: input.gmail_account_id,
    source,
    duration_ms: Date.now() - t0,
    attempts: attempt,
  };

  if (error) {
    const error_code = pgErrorCode(error);
    logMetric("folder_example_write", { ...dims, outcome: "failure", error_code });
    logError("folder_example_write.failed", { ...dims, error_code }, error);
    // Durable failure record so the check-folder-write-alerts cron can detect
    // spikes by (error_code, folder_id) and page us. Best-effort: a logging
    // insert must never mask the original write failure.
    try {
      await supabaseAdmin.from("folder_write_failures").insert({
        user_id: input.user_id,
        gmail_account_id: input.gmail_account_id,
        folder_id: input.folder_id,
        error_code: error_code ?? null,
        source,
      });
    } catch (logErr) {
      logError("folder_write_failure.record_failed", { ...dims, error_code }, logErr);
    }
    return { id: null, error: error.message };
  }

  logMetric("folder_example_write", { ...dims, outcome: "success" });
  return { id: (data as string | null) ?? null, error: null };
}

