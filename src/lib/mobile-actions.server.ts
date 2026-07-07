// Server-only core for mobile mail actions. Mirrors the logic in the web
// server functions (archive / mark read / move) so the mobile API routes and
// the web app stay in sync without duplicating Gmail side-effect handling.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { modifyMessage } from "./gmail.server";
import { getEmailsDecrypted } from "./sync/encrypted-reader";
import { performMove } from "./move-email.server";
import { logError } from "./log.server";

async function getOwnedEmail(userId: string, emailId: string) {
  const { rows, error } = await getEmailsDecrypted([emailId]);
  if (error) throw new Error(error);
  const data = rows[0];
  if (!data || data.user_id !== userId) throw new Error("Email not found");
  if (!data.gmail_message_id || !data.gmail_account_id) {
    throw new Error("Email is missing Gmail identifiers");
  }
  return {
    gmail_message_id: data.gmail_message_id,
    gmail_account_id: data.gmail_account_id,
  };
}

/** Mark an email read/unread in Gmail and locally. */
export async function markEmailReadCore(userId: string, emailId: string, read: boolean) {
  const email = await getOwnedEmail(userId, emailId);
  try {
    await modifyMessage(
      email.gmail_account_id,
      email.gmail_message_id,
      read ? [] : ["UNREAD"],
      read ? ["UNREAD"] : [],
    );
  } catch (e) {
    logError("mobile.mark_read_failed", { email_id: emailId }, e);
  }
  await supabaseAdmin.from("emails").update({ is_read: read }).eq("id", emailId);
  return { ok: true as const };
}

/** Archive an email (remove from inbox) in Gmail and locally. */
export async function archiveEmailCore(userId: string, emailId: string) {
  const email = await getOwnedEmail(userId, emailId);
  try {
    await modifyMessage(email.gmail_account_id, email.gmail_message_id, [], ["INBOX"]);
  } catch (e) {
    logError("mobile.archive_failed", { email_id: emailId }, e);
    throw new Error((e as Error)?.message || "Failed to archive in Gmail", { cause: e });
  }
  const { data: row } = await supabaseAdmin
    .from("emails")
    .select("raw_labels")
    .eq("id", emailId)
    .maybeSingle();
  const nextLabels = (row?.raw_labels ?? []).filter((l: string) => l !== "INBOX");
  await supabaseAdmin
    .from("emails")
    .update({ is_archived: true, raw_labels: nextLabels })
    .eq("id", emailId);
  return { ok: true as const };
}

/** Move an email to a folder, applying the folder's Gmail label + effects. */
export async function moveEmailCore(userId: string, emailId: string, toFolderId: string) {
  const result = await performMove(userId, emailId, toFolderId);
  if (!result.ok) throw new Error(result.error);
  return { ok: true as const };
}
