// Rules-engine audit log (rules upgrade, task 1). One executed_rules row
// is recorded per classification execution — the rules and AI branches of
// the classify path funnel through a single recordExecution call site at
// the end of processGmailMessage, so every ingested email gets exactly one
// row (retries that complete a stuck classification add their own row).
//
// BEST-EFFORT — recordExecution never throws and never blocks classify: a
// failed audit insert is logged (metadata only, never the reason text) and
// dropped.
//
// ENCRYPTION — the classification reason can embed AI output about the
// email, so the record_executed_rule RPC stores it encrypted (reason_enc)
// with EMAIL_ENC_KEY, mirroring emails.classification_reason_enc. Reads
// decrypt via the service-role-only list_executed_rules RPC, scoped to the
// authenticated user's id by the calling server function.
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError } from "@/lib/log.server";
import type { AccountContext } from "./account-context";
import type { ClassificationResult, ParsedEmailForClassify } from "./classify";
import { collectMatchingLeaves } from "./filter-engine";

// The executed_rules RPCs are not in the generated Supabase types yet — go
// through an untyped accessor (same pattern as ai-scan-status.functions.ts).
function adminRpc(fn: string, args: Record<string, unknown>) {
  return (supabaseAdmin as unknown as SupabaseClient).rpc(fn, args);
}

export type ExecutionStatus = "applied" | "skipped" | "error" | "pending";

// Outcomes where a rule/AI produced a candidate that was deliberately not
// applied (veto, confidence threshold, calendar guard) — distinct from
// plain failures.
const SKIPPED_CLASSIFIERS = new Set(["excluded", "ai_low_confidence", "calendar_contact"]);
const ERROR_CLASSIFIERS = new Set(["ai_error", "unclassified"]);

/** Map a classification outcome onto the audit-row status. 'pending'
 * (deferred AI, backfill lane) is passed explicitly by the caller — it is
 * never derived from the classification itself. */
export function statusForClassification(c: ClassificationResult): ExecutionStatus {
  if (ERROR_CLASSIFIERS.has(c.classified_by)) return "error";
  if (SKIPPED_CLASSIFIERS.has(c.classified_by)) return "skipped";
  return "applied";
}

export type MatchedLeaf = { field: string; op: string; value: string };

/** The rule conditions that fired for the routed folder: tree leaves via
 * collectMatchingLeaves when the folder uses a filter_tree, else the
 * matched folder_filters rows' conditions. Empty when no filter matched
 * (gmail_label / AI / no-match outcomes). Leaves are user rule config —
 * field/op/value — never email content. */
export function matchedLeavesFor(
  parsed: ParsedEmailForClassify,
  context: AccountContext,
  c: ClassificationResult,
): MatchedLeaf[] {
  if (!c.folder_id) return [];
  const folder = context.folders.find((f) => f.id === c.folder_id);
  if (folder?.filter_tree) {
    const leaves = collectMatchingLeaves(parsed, folder.filter_tree);
    if (leaves.length > 0) return leaves;
  }
  if (c.matched_filter_ids.length === 0) return [];
  const ids = new Set(c.matched_filter_ids);
  return context.filters
    .filter((f) => ids.has(f.id))
    .map((f) => ({ field: f.field, op: f.op, value: f.value }));
}

export type RecordExecutionInput = {
  userId: string;
  gmailAccountId: string;
  emailId: string | null;
  gmailMessageId: string;
  parsed: ParsedEmailForClassify;
  context: AccountContext;
  classification: ClassificationResult;
  /** Overrides the derived status — the deferred-AI lane passes 'pending'. */
  status?: ExecutionStatus;
  error?: string | null;
  /** False for user-initiated re-classification. The ingest pipeline (the
   * only caller today) is always automated. */
  automated?: boolean;
};

export async function recordExecution(input: RecordExecutionInput): Promise<void> {
  const c = input.classification;
  const status = input.status ?? statusForClassification(c);
  try {
    const key = process.env.EMAIL_ENC_KEY;
    if (!key) throw new Error("EMAIL_ENC_KEY not configured");
    const leaves = matchedLeavesFor(input.parsed, input.context, c);
    const { error } = await adminRpc("record_executed_rule", {
      p_user_id: input.userId,
      p_gmail_account_id: input.gmailAccountId,
      p_email_id: input.emailId,
      p_gmail_message_id: input.gmailMessageId,
      p_folder_id: c.folder_id,
      p_classified_by: c.classified_by,
      p_ai_confidence: c.ai_confidence,
      p_matched_filter_ids: c.matched_filter_ids,
      p_matched_leaf_json: leaves.length > 0 ? leaves : null,
      p_reason: c.classification_reason,
      p_automated: input.automated ?? true,
      p_status: status,
      p_error: input.error ?? null,
      p_key: key,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    logError(
      "executed_rules.record_failed",
      {
        gmail_account_id: input.gmailAccountId,
        email_id: input.emailId,
        classified_by: c.classified_by,
        status,
      },
      e,
    );
  }
}

export type ExecutedRuleRow = {
  id: string;
  gmail_account_id: string;
  email_id: string | null;
  gmail_message_id: string;
  folder_id: string | null;
  folder_name: string | null;
  classified_by: string;
  ai_confidence: number | null;
  matched_filter_ids: string[];
  matched_leaf_json: MatchedLeaf[] | null;
  reason: string | null;
  automated: boolean;
  status: ExecutionStatus;
  error: string | null;
  created_at: string;
};

/** Decrypted executed_rules page for one user, newest first. Server-only:
 * goes through the service-role list RPC with EMAIL_ENC_KEY — the caller
 * (a server function) is responsible for passing its authenticated user
 * id, never client input. */
export async function listExecutedRulesDecrypted(params: {
  userId: string;
  accountId?: string | null;
  folderId?: string | null;
  cursor?: string | null;
  limit?: number;
}): Promise<ExecutedRuleRow[]> {
  const key = process.env.EMAIL_ENC_KEY;
  if (!key) throw new Error("EMAIL_ENC_KEY not configured");
  const { data, error } = await adminRpc("list_executed_rules", {
    p_user_id: params.userId,
    p_account_id: params.accountId ?? null,
    p_folder_id: params.folderId ?? null,
    p_cursor: params.cursor ?? null,
    p_limit: params.limit ?? 500,
    p_key: key,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as ExecutedRuleRow[];
}
