// Shared server-only helpers used by gmail.functions.ts and its
// sibling files (gmail-diagnostics.functions.ts). RLS doesn't apply
// to supabaseAdmin (service role); each helper enforces user_id ownership.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getEmailsDecrypted } from "@/lib/sync/encrypted-reader";

export async function getOwnedAccount(userId: string, accountId: string) {
  const { data, error } = await supabaseAdmin
    .from("gmail_accounts")
    .select("id, user_id")
    .eq("id", accountId)
    .single();
  if (error || !data) throw new Error("Gmail account not found");
  if (data.user_id !== userId) throw new Error("Not authorized for this account");
  return data;
}

export async function getEmailAccount(userId: string, emailId: string) {
  // Plaintext columns were dropped (Phase 3 encryption); read base metadata
  // from the table and the sensitive fields via the decrypt RPC.
  const { data, error } = await supabaseAdmin
    .from("emails")
    .select("id, gmail_message_id, gmail_account_id, user_id, thread_id, from_addr")
    .eq("id", emailId)
    .single();
  if (error || !data) throw new Error("Email not found");
  if (data.user_id !== userId) throw new Error("Not authorized");

  const { rows } = await getEmailsDecrypted([emailId]);
  const dec = rows[0];
  return {
    gmail_message_id: data.gmail_message_id,
    gmail_account_id: data.gmail_account_id,
    user_id: data.user_id,
    thread_id: data.thread_id,
    from_addr: data.from_addr,
    subject: dec?.subject ?? null,
    body_text: dec?.body_text ?? null,
    from_name: dec?.from_name ?? null,
  };
}
