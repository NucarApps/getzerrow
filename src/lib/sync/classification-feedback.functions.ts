// Classification feedback (rules upgrade, task 12).
//
//   * flagWrongClassification — records a classification_feedback row
//     (RLS insert as the caller) and, when a correct folder is chosen,
//     re-routes the email through the SAME performMove path as a
//     manual drag and stores an encrypted few-shot folder_example so
//     the folder learns from the correction.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { performMove } from "../move-email.server";
import { insertFolderExampleEncrypted } from "./encrypted-writer";
import { getEmailsDecrypted } from "./encrypted-reader";
import { loadAccountContext } from "./account-context";
import { matchByFilters, type EmailForFilter } from "./filter-engine";
import { logAudit } from "../log.server";

const admin = () => supabaseAdmin;

type ExecutedRow = {
  id: string;
  user_id: string;
  gmail_account_id: string;
  email_id: string | null;
  gmail_message_id: string;
  folder_id: string | null;
  classified_by: string;
  ai_confidence: number | null;
  matched_leaf_json: Array<{ field: string; op: string; value: string }> | null;
};

export async function getOwnedExecution(id: string, userId: string): Promise<ExecutedRow> {
  const { data, error } = await admin()
    .from("executed_rules")
    .select(
      "id, user_id, gmail_account_id, email_id, gmail_message_id, folder_id, classified_by, ai_confidence, matched_leaf_json",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as ExecutedRow | null;
  if (!row || row.user_id !== userId) throw new Error("Execution not found");
  return row;
}

export const flagWrongClassification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { executed_rule_id: string; correct_folder_id?: string | null; note?: string }) =>
      z
        .object({
          executed_rule_id: z.string().uuid(),
          correct_folder_id: z.string().uuid().nullish(),
          note: z.string().max(500).optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }): Promise<{ ok: true; moved: boolean }> => {
    const { supabase, userId } = context;
    const row = await getOwnedExecution(data.executed_rule_id, userId);

    // Target folder must be the caller's (RLS-scoped lookup).
    if (data.correct_folder_id) {
      const { data: folder } = await supabase
        .from("folders")
        .select("id")
        .eq("id", data.correct_folder_id)
        .maybeSingle();
      if (!folder) throw new Error("Folder not found");
    }

    // RLS insert as the caller — the owner policy enforces user_id.
    const { error: insertErr } = await supabase.from("classification_feedback").insert({
      user_id: userId,
      executed_rule_id: row.id,
      correct_folder_id: data.correct_folder_id ?? null,
      note: data.note?.trim() || null,
    });
    if (insertErr) throw new Error(insertErr.message);

    let moved = false;
    if (data.correct_folder_id && row.email_id) {
      const res = await performMove(
        userId,
        row.email_id,
        data.correct_folder_id,
        "user flagged wrong classification",
      );
      if (!res.ok) throw new Error(res.error);
      moved = true;

      // Few-shot: the corrected email becomes an encrypted example so
      // the folder learns from this mistake (same writer as learn).
      const { rows } = await getEmailsDecrypted([row.email_id]);
      const email = rows[0];
      if (email && email.user_id === userId) {
        await insertFolderExampleEncrypted({
          user_id: userId,
          gmail_account_id: row.gmail_account_id,
          folder_id: data.correct_folder_id,
          gmail_message_id: row.gmail_message_id,
          from_addr: email.from_addr,
          subject: email.subject,
          snippet: email.snippet,
          source: "feedback",
        });
      }
    }

    logAudit("rules.feedback_flagged", {
      user_id: userId,
      executed_rule_id: row.id,
      moved,
    });
    return { ok: true, moved };
  });
