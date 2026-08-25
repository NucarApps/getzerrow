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
  if (decision.trace) await persistDecisionTrace(emailId, decision.trace);
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
