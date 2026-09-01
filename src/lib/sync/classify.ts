// Email classification — the async half of the routing decision.
//
// The deterministic ladder (override → Gmail label → filters → calendar
// guard) lives in ./decide-folder.ts as one pure function shared by every
// path that files mail. This module owns only the rungs that need the AI
// gateway: the AI fallback and the per-folder "surface to inbox" rule.
//
// classifyByRules is kept as a thin, named wrapper over decideFolder so
// existing callers and tests read the same, and so there is exactly one
// implementation of precedence in the codebase.
import { classifyEmail, shouldSurfaceToInbox } from "../ai.server";
import type { RulesTrace } from "../rules/types";
import type { AccountContext } from "./account-context";
import { loadAccountContext } from "./account-context";
import {
  aiCandidateIds,
  decideFolder,
  withAiStep,
  withSurfaceStep,
  type DecisionTrace,
  type DecisionTrigger,
  type FolderDecision,
} from "./decide-folder";
import { runEngineStage } from "./engine-stage";
import { type EmailForFilter } from "./filter-engine";

export type ClassificationResult = {
  folder_id: string | null;
  classified_by: string;
  ai_confidence: number;
  ai_summary: string;
  classification_reason: string | null;
  matched_filter_ids: string[];
  matched_folder_ids: string[];
  /** Why this decision was made — every folder considered, every rule
   * that fired, every veto. Config only, no email content. Absent on
   * results built by older code paths. */
  trace?: DecisionTrace;
  /** The amended engine's v2 trace, present only when the engine decided
   * (RULES_ENGINE_V2=on). apply-decision stores this in preference to the
   * v1 trace above. */
  rules_trace?: RulesTrace;
};

export type ParsedEmailForClassify = {
  from_addr: string;
  from_name: string;
  to_addrs: string;
  cc?: string;
  list_id?: string;
  in_reply_to?: string;
  reply_to_addr?: string | null;
  origin_addr?: string | null;
  subject: string;
  snippet: string;
  body_text: string;
  body_html: string;
  has_attachment: boolean;
  has_calendar_invite?: boolean;
  received_at: string;
  raw_labels: string[] | null;
  /** Contact-group ids the sender belongs to (populated from
   * AccountContext.senderGroups by decideFolder). Optional so
   * callers building ad-hoc parsed emails don't have to compute it. */
  sender_group_ids?: string[];
};

export type RulesClassification = FolderDecision;

/** Deterministic classification: the full precedence ladder from
 * ./decide-folder.ts, minus the two rungs that need the AI gateway. Never
 * calls out — fast enough (10–50ms) to run before the email row is
 * inserted. `trigger` defaults to "arrival"; every caller that files mail
 * through a different door should name its own. */
export function classifyByRules(
  parsed: ParsedEmailForClassify,
  context: AccountContext,
  opts: {
    skipGmailLabelMatch?: boolean;
    /** Prior messages of the same thread (decrypted, truncated) — used by
     * folders with run_on_threads=true. Callers without thread context
     * omit it and every folder behaves message-scoped (task 6 gating). */
    threadEmails?: EmailForFilter[];
    trigger?: DecisionTrigger;
  } = {},
): RulesClassification {
  return decideFolder(parsed, context, {
    trigger: opts.trigger ?? "arrival",
    skipGmailLabelMatch: opts.skipGmailLabelMatch,
    threadEmails: opts.threadEmails,
  });
}

/** The AI classifier's candidate folders, enriched with rules/examples.
 * Eligibility itself is decided by decide-folder's aiCandidateIds so the
 * deterministic and AI rungs can never disagree about which folders are
 * in play. */
function aiCandidateFolders(parsed: ParsedEmailForClassify, context: AccountContext) {
  const eligibleIds = aiCandidateIds(parsed, context);
  return context.enrichedFolders.filter((f) => eligibleIds.has(f.id));
}

/** AI fallback pass. Call only when classifyByRules returned
 * needs_ai=true. Takes the rules result as `base` so non-AI fields
 * (matched_* arrays, exception-note reason) carry through. */
export async function classifyByAi(
  parsed: ParsedEmailForClassify,
  context: AccountContext,
  base: ClassificationResult,
): Promise<ClassificationResult> {
  const out: ClassificationResult = { ...base };
  const aiFolders = aiCandidateFolders(parsed, context);
  if (aiFolders.length === 0) return out;
  const noteAi = (
    suggestedId: string | null,
    suggestedName: string | null,
    confidence: number,
    threshold: number,
    accepted: boolean,
  ) => {
    if (!base.trace) return;
    out.trace = withAiStep(base.trace, {
      suggested_folder_id: suggestedId,
      suggested_folder_name: suggestedName,
      confidence,
      threshold,
      accepted,
    });
  };
  try {
    const r = await classifyEmail(parsed, aiFolders);
    const candidate = context.folders.find((f) => f.id === r.folder_id);
    const threshold = candidate?.min_ai_confidence ?? 0;
    if (r.folder_id && r.confidence >= threshold) {
      out.folder_id = r.folder_id;
      out.ai_confidence = r.confidence;
      out.ai_summary = r.summary;
      out.classified_by = "ai";
      out.classification_reason = r.reason || null;
      noteAi(r.folder_id, candidate?.name ?? null, r.confidence, threshold, true);
    } else if (r.folder_id) {
      out.classified_by = "ai_low_confidence";
      out.ai_confidence = r.confidence;
      out.ai_summary = r.summary;
      out.classification_reason = `AI suggested "${candidate?.name ?? "?"}" at ${(r.confidence * 100).toFixed(0)}% < min ${(threshold * 100).toFixed(0)}%`;
      noteAi(r.folder_id, candidate?.name ?? null, r.confidence, threshold, false);
    } else {
      out.classified_by = "ai";
      out.ai_confidence = r.confidence;
      out.ai_summary = r.summary;
      out.classification_reason = r.reason || null;
      noteAi(null, null, r.confidence, threshold, false);
    }
  } catch (e) {
    console.error("AI classify failed", e);
    out.classified_by = "ai_error";
    out.classification_reason = `AI classifier failed: ${(e as Error)?.message ?? "unknown error"}`;
  }
  return out;
}

export async function classifyParsedEmail(
  parsed: ParsedEmailForClassify,
  userId: string,
  accountId: string,
  opts: {
    skipGmailLabelMatch?: boolean;
    context?: AccountContext;
    skipAi?: boolean;
    threadEmails?: EmailForFilter[];
  } = {},
): Promise<ClassificationResult> {
  const context = opts.context ?? (await loadAccountContext(accountId, userId));
  const legacy = classifyByRules(parsed, context, {
    skipGmailLabelMatch: opts.skipGmailLabelMatch,
    threadEmails: opts.threadEmails,
  });
  // Phase E cutover: the amended engine either runs alongside for
  // comparison (shadow, the default) or decides outright.
  const rules = runEngineStage(parsed, context, legacy, {
    skipGmailLabelMatch: opts.skipGmailLabelMatch,
    threadEmails: opts.threadEmails,
  });
  if (rules.needs_ai && !opts.skipAi) {
    return classifyByAi(parsed, context, rules);
  }
  // Rules routed this into a folder with a surface rule — let the AI
  // decide whether it should be kept visible in the inbox instead.
  if (rules.needs_surface_check && !opts.skipAi && rules.folder_id) {
    const decision = await applySurfaceRule(parsed, context, rules.folder_id);
    if (decision.surface) {
      return {
        ...rules,
        classified_by: "surfaced_to_inbox",
        classification_reason: decision.reason
          ? `Surfaced to inbox: ${decision.reason}`
          : "Surfaced to inbox by folder rule",
        ...(rules.trace
          ? { trace: withSurfaceStep(rules.trace, true, decision.reason ?? "") }
          : {}),
      };
    }
    if (rules.trace) return { ...rules, trace: withSurfaceStep(rules.trace, false, "") };
  }
  return rules;
}

export type SurfaceDecision = {
  /** True = keep the email visible in the inbox (still filed into the folder). */
  surface: boolean;
  reason: string;
};

/** Run a folder's "surface to inbox" rule against a rule-filed email.
 * Only call when classifyByRules returned needs_surface_check=true.
 * Combines the connected Gmail address with the folder's optional
 * names/aliases as the "me" identity for the AI's judgment. */
export async function applySurfaceRule(
  parsed: ParsedEmailForClassify,
  context: AccountContext,
  folderId: string,
): Promise<SurfaceDecision> {
  const folder = context.folders.find((f) => f.id === folderId);
  const rule = folder?.surface_ai_rule?.trim();
  if (!folder || !rule) return { surface: false, reason: "" };

  const identityEmails = [context.accountEmail]
    .filter((e): e is string => !!e)
    .map((e) => e.toLowerCase());
  const identityNames = (folder.surface_names ?? "")
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return shouldSurfaceToInbox(
    {
      from_addr: parsed.from_addr,
      from_name: parsed.from_name,
      to_addrs: parsed.to_addrs,
      cc: parsed.cc,
      subject: parsed.subject,
      snippet: parsed.snippet,
      body_text: parsed.body_text,
    },
    { folderName: folder.name, surfaceRule: rule, identityEmails, identityNames },
  );
}
