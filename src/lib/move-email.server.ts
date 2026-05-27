// Server-only helper for moving an email to a folder. Extracted from
// gmail.functions.ts so it can be safely imported from other .functions.ts
// files without dragging gmail.functions's full top-level import graph
// (google-oauth.server, etc.) into the client bundle.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { modifyMessage } from "./gmail.server";
import { logError } from "./log.server";

export async function performMove(
  userId: string,
  emailId: string,
  toFolderId: string,
  reasonOverride?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: email } = await supabaseAdmin
    .from("emails")
    .select("id, user_id, folder_id, gmail_message_id, gmail_account_id, from_addr, subject, snippet")
    .eq("id", emailId)
    .single();
  if (!email || email.user_id !== userId) return { ok: false, error: "Email not found" };
  if (email.folder_id === toFolderId) return { ok: true };

  const ids = [toFolderId, ...(email.folder_id ? [email.folder_id] : [])];
  const { data: folders } = await supabaseAdmin
    .from("folders")
    .select("id, user_id, name, gmail_label_id")
    .in("id", ids);
  const to = folders?.find((f) => f.id === toFolderId);
  if (!to || to.user_id !== userId) return { ok: false, error: "Target folder not found" };
  const from = email.folder_id ? folders?.find((f) => f.id === email.folder_id) : null;

  const reason = reasonOverride ?? (from
    ? `Re-categorized from "${from.name}" to "${to.name}"`
    : `Moved to "${to.name}" manually`);

  const { data: cur } = await supabaseAdmin
    .from("emails")
    .select("raw_labels")
    .eq("id", email.id)
    .maybeSingle();
  const curLabels = (cur?.raw_labels ?? []) as string[];
  const fromLabelId = from?.gmail_label_id ?? null;
  const toLabelId = to.gmail_label_id ?? null;
  const nextLabels = Array.from(new Set([
    ...curLabels.filter((l) => l !== "INBOX" && (!fromLabelId || l !== fromLabelId)),
    ...(toLabelId ? [toLabelId] : []),
  ]));

  const { error: upErr } = await supabaseAdmin
    .from("emails")
    .update({
      folder_id: toFolderId,
      classified_by: "manual_move",
      ai_confidence: 1,
      classification_reason: reason,
      is_archived: true,
      raw_labels: nextLabels,
    })
    .eq("id", email.id);
  if (upErr) return { ok: false, error: upErr.message };

  const addLabels = toLabelId ? [toLabelId] : [];
  const removeLabels = ["INBOX", ...(fromLabelId ? [fromLabelId] : [])];
  try {
    await modifyMessage(
      email.gmail_account_id,
      email.gmail_message_id,
      addLabels,
      removeLabels,
    );
  } catch (e) {
    logError("gmail.label_sync.failed", {}, e);
  }

  if (from) {
    await supabaseAdmin
      .from("folder_examples")
      .delete()
      .eq("folder_id", from.id)
      .eq("gmail_message_id", email.gmail_message_id);
  }
  await supabaseAdmin.from("folder_examples").upsert(
    {
      folder_id: toFolderId,
      user_id: userId,
      gmail_account_id: email.gmail_account_id,
      gmail_message_id: email.gmail_message_id,
      from_addr: email.from_addr,
      subject: email.subject,
      snippet: email.snippet,
      source: "correction",
    },
    { onConflict: "folder_id,gmail_message_id" },
  );

  try {
    const { regenerateFolderProfile } = await import("./sync.server");
    void regenerateFolderProfile(toFolderId).catch((e) =>
      logError("gmail.auto_retrain.after_move_failed", { folder_id: toFolderId }, e),
    );
  } catch (e) {
    logError("gmail.auto_retrain.import_failed", {}, e);
  }

  return { ok: true };
}
