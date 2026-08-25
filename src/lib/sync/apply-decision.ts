// The single writer for routing decisions.
//
// Every path that files an email — arrival, AI backfill, Gmail label
// change, manual move, rescue passes — persists through persistDecision so
// there is exactly one place that decides which columns a decision touches
// and one place that stores the explanation of *why*.
//
// Sensitive fields (ai_summary, classification_reason) go through the
// encryption RPC. The decision trace holds only folder/rule metadata (ids,
// names, operators, verdicts) — never message content — so it is stored as
// plain jsonb and can be read straight back by the AI decision drawer.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError } from "@/lib/log.server";
import type { ClassificationResult } from "./classify";
import type { Collision, RulesTrace } from "@/lib/rules/types";
import type { DecisionTrace } from "./decide-folder";
import { updateEmailEncrypted } from "./encrypted-writer";

/** Persist a classification outcome onto an existing email row.
 *
 * The RPC treats a null folder_id as "leave unchanged", which is what
 * callers want: a null outcome leaves the message where it already is
 * (the Inbox for a fresh row). */
export async function persistDecision(
  emailId: string,
  decision: ClassificationResult,
): Promise<{ error: string | null }> {
  const res = await updateEmailEncrypted({
    email_id: emailId,
    folder_id: decision.folder_id,
    ai_summary: decision.ai_summary || null,
    ai_confidence: decision.ai_confidence,
    classified_by: decision.classified_by,
    classification_reason: decision.classification_reason,
    matched_filter_ids: decision.matched_filter_ids,
    matched_folder_ids: decision.matched_folder_ids,
  });
  // A v2 trace wins when the amended engine decided: it explains the same
  // decision in more detail, and the readers narrow by `version`.
  if (decision.rules_trace) await persistRulesTrace(emailId, decision.rules_trace);
  else if (decision.trace) await persistDecisionTrace(emailId, decision.trace);
  return res;
}

/** Store the "why" alongside the decision. Best-effort: an explanation
 * that fails to save must never fail the routing write itself. */
export async function persistDecisionTrace(
  emailId: string,
  trace: DecisionTrace,
): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from("emails")
      .update({ decision_trace: trace } as never)
      .eq("id", emailId);
    if (error) {
      logError("decision_trace.save_failed", { email_id: emailId }, error);
    }
  } catch (e) {
    logError("decision_trace.save_failed", { email_id: emailId }, e);
  }
}

/** Store a v2 trace from the amended engine (src/lib/rules). Same column,
 * same best-effort contract as the v1 writer above — the readers narrow by
 * `version`, so both generations can coexist during the switch-over. */
export async function persistRulesTrace(emailId: string, trace: RulesTrace): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from("emails")
      .update({ decision_trace: trace } as never)
      .eq("id", emailId);
    if (error) logError("rules_trace.save_failed", { email_id: emailId }, error);
  } catch (e) {
    logError("rules_trace.save_failed", { email_id: emailId }, e);
  }
}

/** Provenance: this message was placed by a human. Continuity (stage 4)
 * and the golden set may chain off it; replay change-sets never move it. */
export async function markPlacedByUser(emailId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from("emails")
      .update({ placed_by_user: true } as never)
      .eq("id", emailId);
    if (error) logError("placed_by_user.save_failed", { email_id: emailId }, error);
  } catch (e) {
    logError("placed_by_user.save_failed", { email_id: emailId }, e);
  }
}

/** Runtime collision defence (Amendment 3): two same-level rules claimed
 * this message for different folders. The older rule already won — this
 * records the event so the UI can ask for an exception. Never silent,
 * never fatal to the routing write. */
export async function recordCollisionEvent(args: {
  userId: string;
  emailId: string | null;
  collision: Collision;
  winnerFolderId: string | null;
}): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("rule_collision_events").insert({
      user_id: args.userId,
      email_id: args.emailId,
      level: args.collision.level,
      winner_rule_id: args.collision.winner_rule_id,
      winner_folder_id: args.winnerFolderId,
      loser_rule_ids: args.collision.loser_rule_ids,
      folder_ids: args.collision.folder_ids,
      reason: args.collision.reason,
    } as never);
    if (error) logError("rule_collision.save_failed", { email_id: args.emailId }, error);
  } catch (e) {
    logError("rule_collision.save_failed", { email_id: args.emailId }, e);
  }
}
