// Shared server-only helpers used by gmail.functions.ts and its
// sibling files (gmail-diagnostics.functions.ts). RLS doesn't apply
// to supabaseAdmin (service role); each helper enforces user_id ownership.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

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
  // emails_decrypted view decrypts body_text on read.
  const { data, error } = await supabaseAdmin
    .from("emails_decrypted")
    .select("gmail_message_id, gmail_account_id, user_id, thread_id, from_addr, subject, body_text, from_name")
    .eq("id", emailId)
    .single();
  if (error || !data) throw new Error("Email not found");
  if (data.user_id !== userId) throw new Error("Not authorized");
  return data;
}
