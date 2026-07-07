// Email classification — the decision tree that decides which folder
// (if any) an incoming message belongs to.
//
// ROUTING ORDER (first match wins)
//   1. Inbox override (email/domain blocklist) + per-override exception
//      — the user's "never put this in my inbox" rule.
//   2. Gmail label match — message already carries a label that maps to
//      one of our folders.
//   3. Folder filter tree / simple any-all filters — user-defined rules.
//   4. AI classifier — fallback when nothing else fires, gated by each
//      folder's min_ai_confidence and skip_ai flag.
//
// OVERRIDES
//   A folder with overrides_inbox_override=true beats a matching inbox
//   override — that's how "always route CEO emails to Priority even if
//   their domain is on my blocklist" works.
//
// PURITY
//   This module is mostly pure but does call out to ai.server.classifyEmail
//   when no rule matches. Callers can suppress that with skipAi=true (used
//   by backfill batch processing).
import { classifyEmail, shouldSurfaceToInbox } from "../ai.server";
import type { AccountContext } from "./account-context";
import { loadAccountContext } from "./account-context";
import { applyFilter, matchByFilters, labelOf, emailVetoedForFolder } from "./filter-engine";
import type { OverrideException } from "./types";

export type ClassificationResult = {
  folder_id: string | null;
  classified_by: string;
  ai_confidence: number;
  ai_summary: string;
  classification_reason: string | null;
  matched_filter_ids: string[];
  matched_folder_ids: string[];
};

export type ParsedEmailForClassify = {
  from_addr: string;
  from_name: string;
  to_addrs: string;
  cc?: string;
  list_id?: string;
  in_reply_to?: string;
  subject: string;
  snippet: string;
  body_text: string;
  body_html: string;
  has_attachment: boolean;
  has_calendar_invite?: boolean;
  received_at: string;
  raw_labels: string[] | null;
};

export type RulesClassification = ClassificationResult & {
  /** True when no rule fired AND there are AI-eligible folders — i.e.
   * the result is provisional and classifyByAi should run. False means
   * the rules result is final (matched, excluded, or nothing for AI to
   * do). */
  needs_ai: boolean;
  /** True when rules routed this mail into a folder that carries a
   * non-empty surface_ai_rule — the async surface pass must decide
   * whether to keep the email visible in the inbox. */
  needs_surface_check: boolean;
};

/** Synchronous rules-only classification: inbox override (+ exceptions)
 * → Gmail label match → folder filter tree / simple filters. Never
 * calls the AI gateway — fast enough (10–50ms) to run before the email
 * row is inserted. */
export function classifyByRules(
  parsed: ParsedEmailForClassify,
  context: AccountContext,
  opts: { skipGmailLabelMatch?: boolean } = {},
): RulesClassification {
  const folderList = context.folders;
  const filterList = context.filters;
  const overrides = context.overrides;
  const overrideExceptions = context.overrideExceptions;

  let folder_id: string | null = null;
  let classified_by = "none";
  let confidence = 0;
  const summary = "";
  let classification_reason: string | null = null;
  let matched_filter_ids: string[] = [];
  let matched_folder_ids: string[] = [];
  let aiSkipped = false;

  const fromAddr = (parsed.from_addr || "").toLowerCase();
  const fromDomain = fromAddr.split("@")[1] || "";
  const overrideHit = overrides.find((o) => {
    const val = (o.value || "").toLowerCase();
    return o.match_type === "email" ? val === fromAddr : val === fromDomain;
  });

  // If override fired, check per-override exceptions (same applyFilter
  // evaluator used by folder filters, including
  // starts_with/ends_with/contains/regex).
  let overrideExceptionHit: OverrideException | null = null;
  if (overrideHit) {
    const exForThisOverride = overrideExceptions.filter((e) => e.override_id === overrideHit.id);
    for (const ex of exForThisOverride) {
      if (
        applyFilter(parsed, { id: "", folder_id: "", field: ex.field, op: ex.op, value: ex.value })
      ) {
        overrideExceptionHit = ex;
        break;
      }
    }
  }

  // Folder match (computed up-front so we can let a folder beat the
  // override when its `overrides_inbox_override` flag is on).
  const labeledFolder = opts.skipGmailLabelMatch
    ? undefined
    : folderList.find((f) => f.gmail_label_id && parsed.raw_labels?.includes(f.gmail_label_id));
  const folderMatch = labeledFolder ? null : matchByFilters(parsed, folderList, filterList);
  const beatingFolderId =
    overrideHit && folderMatch?.kind === "match"
      ? (folderMatch.all_matched_folder_ids.find((fid) => {
          const f = folderList.find((x) => x.id === fid);
          return f?.overrides_inbox_override === true;
        }) ?? null)
      : null;

  const overrideWins = !!overrideHit && !overrideExceptionHit && !beatingFolderId;

  if (overrideWins) {
    classified_by = "inbox_override";
    classification_reason = `Global inbox list: ${overrideHit!.match_type} "${overrideHit!.value}"`;
    aiSkipped = true;
  } else {
    if (labeledFolder) {
      folder_id = labeledFolder.id;
      classified_by = "gmail_label";
      confidence = 1;
      classification_reason = `Already labeled "${labeledFolder.name}" in Gmail at sync time`;
    } else {
      const m = folderMatch;
      // If a beatingFolder forced us past the override, prefer that folder
      // even if matchByFilters' priority sort picked a different one.
      const winningFolderId = beatingFolderId ?? (m?.kind === "match" ? m.folder_id : null);
      if (m?.kind === "match" && winningFolderId) {
        folder_id = winningFolderId;
        matched_folder_ids = m.all_matched_folder_ids;
        confidence = 1;
        if (m.tree_used) {
          classified_by = "filter";
          classification_reason = `Rule group matched for "${labelOf(folderList, winningFolderId)}"`;
        } else if (m.filter) {
          classified_by = m.filter.field === "domain" ? "domain_rule" : "filter";
          matched_filter_ids = m.matched_filters.map((f) => f.id);
          classification_reason =
            classified_by === "domain_rule"
              ? `Domain rule: ${m.filter.value} → ${labelOf(folderList, winningFolderId)}`
              : `Filter: ${m.filter.field} ${m.filter.op} "${m.filter.value}"`;
        }
        if (beatingFolderId && overrideHit) {
          classification_reason =
            (classification_reason ?? "") + ` (beat inbox override "${overrideHit.value}")`;
        } else if (overrideExceptionHit && overrideHit) {
          classification_reason =
            (classification_reason ?? "") +
            ` (exception to inbox override "${overrideHit.value}": ${overrideExceptionHit.field} ${overrideExceptionHit.op} "${overrideExceptionHit.value}")`;
        }
        // Calendar cold-email guard: known calendar contacts must never be
        // routed into a folder flagged is_cold_email when the guard is on.
        if (context.calendarGuardEnabled && context.calendarContacts.has(fromAddr)) {
          const winningFolder = folderList.find((f) => f.id === winningFolderId);
          if (winningFolder?.is_cold_email) {
            folder_id = null;
            classified_by = "calendar_contact";
            classification_reason = `Known calendar contact — not routed to "${winningFolder.name}"`;
          }
        }
      } else if (m?.kind === "excluded") {
        classified_by = "excluded";
        classification_reason = `Would match "${m.folder_name}" but excluded by rule: ${m.exclude.field} ${m.exclude.op} "${m.exclude.value}"`;
        aiSkipped = true;
      } else if (overrideExceptionHit && overrideHit) {
        // Exception fired but no folder matched — fall through to AI; note it.
        classification_reason = `Inbox override "${overrideHit.value}" bypassed by exception (${overrideExceptionHit.field} ${overrideExceptionHit.op} "${overrideExceptionHit.value}")`;
      }
    }
  }

  const needs_ai =
    !folder_id &&
    !aiSkipped &&
    folderList.length > 0 &&
    aiCandidateFolders(parsed, context).length > 0;

  // A folder the rules routed into may carry a "surface to inbox" rule.
  // Only rule-based routing (label/filter/domain) triggers the surface
  // check — AI-classified mail runs its own pass.
  const routedFolder = folder_id ? folderList.find((f) => f.id === folder_id) : null;
  const needs_surface_check =
    !!folder_id &&
    !!routedFolder?.surface_ai_rule &&
    routedFolder.surface_ai_rule.trim().length > 0;

  return {
    folder_id,
    classified_by,
    ai_confidence: confidence,
    ai_summary: summary,
    classification_reason,
    matched_filter_ids,
    matched_folder_ids,
    needs_ai,
    needs_surface_check,
  };
}

/** AI-eligible folder set: enrichedFolders minus folders flagged skip_ai and
 * minus any folder whose allowlist / exclusion rules the email violates (so
 * the AI classifier can never place mail into a folder its own hard rules
 * would reject). */
function aiCandidateFolders(parsed: ParsedEmailForClassify, context: AccountContext) {
  const skipAiIds = new Set(context.folders.filter((f) => f.skip_ai).map((f) => f.id));
  return context.enrichedFolders.filter(
    (f) => !skipAiIds.has(f.id) && !emailVetoedForFolder(parsed, f.id, context.filters),
  );
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
    } else if (r.folder_id) {
      out.classified_by = "ai_low_confidence";
      out.ai_confidence = r.confidence;
      out.ai_summary = r.summary;
      out.classification_reason = `AI suggested "${candidate?.name ?? "?"}" at ${(r.confidence * 100).toFixed(0)}% < min ${(threshold * 100).toFixed(0)}%`;
    } else {
      out.classified_by = "ai";
      out.ai_confidence = r.confidence;
      out.ai_summary = r.summary;
      out.classification_reason = r.reason || null;
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
  opts: { skipGmailLabelMatch?: boolean; context?: AccountContext; skipAi?: boolean } = {},
): Promise<ClassificationResult> {
  const context = opts.context ?? (await loadAccountContext(accountId, userId));
  const rules = classifyByRules(parsed, context, { skipGmailLabelMatch: opts.skipGmailLabelMatch });
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
      };
    }
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
