// Explain-classification + feedback (rules upgrade, task 12).
//
//   * explainExecution — for an executed_rules row the caller owns,
//     returns the matched conditions/confidence plus DETERMINISTIC
//     alternative folders: the email is re-run through matchByFilters
//     and every other folder whose rules also matched is offered
//     (top 3, priority order). No AI, no scoring model — the sketch's
//     "evalNode score" doesn't exist; rule matching is boolean, so
//     priority order IS the ranking. (Reason text is not re-returned:
//     list_executed_rules already delivers it decrypted.)
//   * flagWrongClassification — records a classification_feedback row
//     (RLS insert as the caller) and, when a correct folder is chosen,
//     re-routes the email through the SAME performMove path as a
//     manual drag and stores an encrypted few-shot folder_example so
//     the folder learns from the correction.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { performMove } from "../move-email.server";
import { insertFolderExampleEncrypted } from "./encrypted-writer";
import { getEmailsDecrypted } from "./encrypted-reader";
import { loadAccountContext } from "./account-context";
import { matchByFilters, type EmailForFilter } from "./filter-engine";
import { logAudit } from "../log.server";

const admin = () => supabaseAdmin as unknown as SupabaseClient;

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

export type ExplainResult = {
  classified_by: string;
  ai_confidence: number | null;
  matched_leaves: Array<{ field: string; op: string; value: string }>;
  alternative_folders: Array<{ id: string; name: string }>;
};

export const explainExecution = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { executed_rule_id: string }) =>
    z.object({ executed_rule_id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }): Promise<ExplainResult> => {
    const row = await getOwnedExecution(data.executed_rule_id, context.userId);

    let alternatives: Array<{ id: string; name: string }> = [];
    if (row.email_id) {
      const { rows } = await getEmailsDecrypted([row.email_id]);
      const email = rows[0];
      if (email && email.user_id === context.userId) {
        const ctx = await loadAccountContext(row.gmail_account_id, context.userId);
        const from = (email.from_addr ?? "").toLowerCase();
        const groupHits = ctx.senderGroups.get(from);
        const forFilter: EmailForFilter = {
          from_addr: email.from_addr ?? "",
          from_name: email.from_name ?? "",
          to_addrs: email.to_addrs ?? "",
          cc: email.cc ?? undefined,
          subject: email.subject ?? "",
          body_text: email.body_text ?? "",
          has_attachment: email.has_attachment,
          sender_group_ids: groupHits ? Array.from(groupHits) : [],
        };
        const m = matchByFilters(forFilter, ctx.folders, ctx.filters);
        if (m?.kind === "match") {
          const nameById = new Map(ctx.folders.map((f) => [f.id, f.name]));
          alternatives = m.all_matched_folder_ids
            .filter((id) => id !== row.folder_id)
            .slice(0, 3)
            .map((id) => ({ id, name: nameById.get(id) ?? "Unknown folder" }));
        }
      }
    }

    return {
      classified_by: row.classified_by,
      ai_confidence: row.ai_confidence,
      matched_leaves: row.matched_leaf_json ?? [],
      alternative_folders: alternatives,
    };
  });

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
    // (Untyped accessor: the table isn't in the generated types yet.)
    const { error: insertErr } = await (supabase as unknown as SupabaseClient)
      .from("classification_feedback")
      .insert({
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
