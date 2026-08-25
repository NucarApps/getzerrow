// Rule planner server functions (Phase D).
//
//   previewRuleChange   — save-time collision check + replay change-set for
//                         a candidate rule. Read-only: nothing is saved and
//                         no mail moves. Also powers the live preview while
//                         the editor is being typed into.
//   applyRuleChangeSet  — apply selected moves from a previewed change-set.
//                         Hand-placed mail is refused server-side, not just
//                         hidden in the UI.
//
// The AI stage never runs on either path (Amendment 1), so a preview is
// reproducible and free.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { checkRuleConflicts, type ConflictReport } from "./conflicts";
import { buildChangeSet, describeChangeSet, type ChangeSet } from "./replay";
import { deriveRuleLevel } from "./specificity";
import type { Rule } from "./types";

/** Cap on moves applied per request. A larger change-set is applied in
 * successive batches by the dialog. */
export const MAX_APPLIED_MOVES = 200;

const conditionSchema = z.object({
  field: z.string().min(1).max(40),
  op: z.string().min(1).max(40),
  value: z.string().max(500),
});

const previewInput = z.object({
  account_id: z.string().uuid(),
  /** Destination folder of the candidate rule. */
  folder_id: z.string().uuid(),
  /** Set when editing an existing rule so it can't conflict with itself. */
  rule_id: z.string().max(120).nullish(),
  /** Extra rule ids the candidate replaces (a merged pair, for example). */
  replaces_rule_ids: z.array(z.string().max(120)).max(20).default([]),
  /** OR of ANDs. One group is the common case. */
  groups: z.array(z.array(conditionSchema).min(1).max(10)).min(1).max(5),
  days: z.number().int().min(1).max(90).default(90),
});

export type PreviewRuleChange = {
  conflicts: ConflictReport;
  change_set: ChangeSet;
  headline: string;
  level: 1 | 2 | 3 | 4 | 5;
  scanned: number;
};

export const previewRuleChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => previewInput.parse(d))
  .handler(async ({ data, context }): Promise<PreviewRuleChange> => {
    const { supabase, userId } = context;

    // Ownership: the RLS-scoped client returns nothing for an account or
    // folder the caller doesn't own.
    const { data: account } = await supabase
      .from("gmail_accounts")
      .select("id")
      .eq("id", data.account_id)
      .maybeSingle();
    if (!account) throw new Error("Account not found");
    const { data: folder } = await supabase
      .from("folders")
      .select("id")
      .eq("id", data.folder_id)
      .maybeSingle();
    if (!folder) throw new Error("Folder not found");

    const { loadPlannerSnapshot, withCandidate } = await import("./planner.server");
    const snapshot = await loadPlannerSnapshot(supabase, data.account_id, userId, {
      days: data.days,
    });

    const candidate: Rule = {
      id: data.rule_id ?? "candidate",
      folder_id: data.folder_id,
      // A brand-new rule is the youngest, so it loses the age tiebreak
      // against everything that already exists — same as after saving.
      created_at: new Date().toISOString(),
      groups: data.groups,
    };
    candidate.specificity_level = deriveRuleLevel(candidate);

    const replaced = [
      ...data.replaces_rule_ids,
      ...(data.rule_id ? [data.rule_id] : []),
    ];

    const conflicts = checkRuleConflicts(
      candidate,
      snapshot.rules,
      snapshot.context.folders,
      snapshot.messages,
      { ignoreRuleIds: replaced },
    );

    const change_set = buildChangeSet(
      snapshot.messages,
      withCandidate(snapshot, candidate, replaced),
      { trigger: "replay" },
    );

    return {
      conflicts,
      change_set,
      headline: describeChangeSet(change_set),
      level: candidate.specificity_level,
      scanned: snapshot.messages.length,
    };
  });

export const applyRuleChangeSet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        moves: z
          .array(
            z.object({
              email_id: z.string().uuid(),
              /** null = back to the Inbox. */
              to_folder_id: z.string().uuid().nullable(),
            }),
          )
          .min(1)
          .max(MAX_APPLIED_MOVES),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { applyMoves } = await import("./planner-apply.server");
    return applyMoves(context.userId, data.moves);
  });
