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
import { classifyEmail } from "../ai.server";
import type { AccountContext } from "./account-context";
import { loadAccountContext } from "./account-context";
import { applyFilter, matchByFilters, labelOf } from "./filter-engine";
import type { OverrideException } from "./types";
import { logError } from "../log.server";

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
  received_at: string;
  raw_labels: string[] | null;
};

export async function classifyParsedEmail(
  parsed: ParsedEmailForClassify,
  userId: string,
  accountId: string,
  opts: { skipGmailLabelMatch?: boolean; context?: AccountContext; skipAi?: boolean } = {},
): Promise<ClassificationResult> {
  const context = opts.context ?? (await loadAccountContext(accountId, userId));
  const folderList = context.folders;
  const filterList = context.filters;
  const overrides = context.overrides;
  const overrideExceptions = context.overrideExceptions;

  let folder_id: string | null = null;
  let classified_by = "none";
  let confidence = 0;
  let summary = "";
  let classification_reason: string | null = null;
  let matched_filter_ids: string[] = [];
  let matched_folder_ids: string[] = [];
  let aiSkipped = false;

  const fromAddr = (parsed.from_addr || "").toLowerCase();
  const fromDomain = fromAddr.split("@")[1] || "";

  // Calendar cold-email guard: if the account has it enabled and the sender
  // is someone the user has met in Google Calendar, pin the message to the
  // inbox with no folder — same allowlist semantics as an inbox override.
  // This beats folder filters and AI so a known contact is never treated as
  // cold. Runs first so it short-circuits the rest of the decision tree.
  if (context.calendarGuardEnabled && fromAddr && context.calendarContacts.has(fromAddr)) {
    return {
      folder_id: null,
      classified_by: "calendar_contact",
      ai_confidence: 0,
      ai_summary: "",
      classification_reason: "Met in Google Calendar — kept in inbox",
      matched_filter_ids: [],
      matched_folder_ids: [],
    };
  }

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
      if (applyFilter(parsed, { id: "", folder_id: "", field: ex.field, op: ex.op, value: ex.value })) {
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
      ? folderMatch.all_matched_folder_ids.find((fid) => {
          const f = folderList.find((x) => x.id === fid);
          return f?.overrides_inbox_override === true;
        }) ?? null
      : null;

  const overrideWins = !!overrideHit && !overrideExceptionHit && !beatingFolderId;

  if (overrideWins) {
    // Allowlist semantics: a hit forces the email into the inbox with no
    // folder assignment, bypassing filter rules and AI. Side-effects in
    // process-message only fire when folder_id is set, so leaving it null
    // also disables auto-archive / hide / forward / snooze.
    folder_id = null;
    classified_by = "inbox_override";
    classification_reason = `Always-inbox: ${overrideHit!.match_type} "${overrideHit!.value}"`;
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
            (classification_reason ?? "") +
            ` (beat inbox override "${overrideHit.value}")`;
        } else if (overrideExceptionHit && overrideHit) {
          classification_reason =
            (classification_reason ?? "") +
            ` (exception to inbox override "${overrideHit.value}": ${overrideExceptionHit.field} ${overrideExceptionHit.op} "${overrideExceptionHit.value}")`;
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

  if (!folder_id && !aiSkipped && !opts.skipAi && folderList.length > 0) {
    // Exclude folders flagged skip_ai from the AI candidate set.
    const skipAiIds = new Set(folderList.filter((f) => f.skip_ai).map((f) => f.id));
    const aiFolders = context.enrichedFolders.filter((f) => !skipAiIds.has(f.id));
    if (aiFolders.length > 0) {
      try {
        const r = await classifyEmail(parsed, aiFolders);
        const candidate = folderList.find((f) => f.id === r.folder_id);
        const threshold = candidate?.min_ai_confidence ?? 0;
        if (r.folder_id && r.confidence >= threshold) {
          folder_id = r.folder_id;
          confidence = r.confidence;
          summary = r.summary;
          classified_by = "ai";
          classification_reason = r.reason || null;
        } else if (r.folder_id) {
          classified_by = "ai_low_confidence";
          confidence = r.confidence;
          summary = r.summary;
          classification_reason = `AI suggested "${candidate?.name ?? "?"}" at ${(r.confidence * 100).toFixed(0)}% < min ${(threshold * 100).toFixed(0)}%`;
        } else {
          classified_by = "ai";
          confidence = r.confidence;
          summary = r.summary;
          classification_reason = r.reason || null;
        }
      } catch (e) {
        logError("classify.ai_failed", { user_id: userId, account_id: accountId, folder_count: aiFolders.length }, e);
        classified_by = "ai_error";
        classification_reason = `AI classifier failed: ${(e as Error)?.message ?? "unknown error"}`;
      }
    }
  }

  return {
    folder_id,
    classified_by,
    ai_confidence: confidence,
    ai_summary: summary,
    classification_reason,
    matched_filter_ids,
    matched_folder_ids,
  };
}
