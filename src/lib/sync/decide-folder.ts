// THE decision. One pure function that answers "which folder does this
// email belong in, and why" for every trigger in the system.
//
// WHY THIS EXISTS
//   Before this module there were nine places that could write
//   emails.folder_id, and each implemented a different subset of the
//   precedence: the Gmail-label mirror skipped overrides and vetoes
//   entirely, the ingest/backfill paths skipped overrides, the cold-email
//   guard and surface rules; manual moves and rule actions skipped
//   everything. Same mailbox, same rules, different answers depending on
//   which door the message came through.
//
// PRECEDENCE — identical for every trigger, top to bottom:
//   1. paused folder            → inert, never a destination
//   2. exclusion / domain_in    → folder disqualified (veto)
//   3. always-inbox override    → inbox, unless a folder opts out
//                                 (overrides_inbox_override) or an
//                                 override exception fires
//   4. linked Gmail label       → that folder
//   5. filter tree / filters    → highest-priority surviving folder
//   6. calendar cold-email guard→ inbox
//   7. AI                       → only for folders with a non-empty
//                                 ai_rule, not skip_ai, above the
//                                 folder's min_ai_confidence
//   8. surface-to-inbox rule    → stay visible in inbox, still filed
//   9. nothing matched          → inbox
//
//   Rungs 7 and 8 need the AI gateway, so they are not decided here:
//   decideFolder reports needs_ai / needs_surface_check and the async
//   passes in classify.ts finish the ladder. Everything deterministic is
//   decided here, purely, and is therefore testable rung by rung.
//
// PURITY
//   No Supabase, no AI, no clock. Same inputs → same decision → same
//   trace. apply-decision.ts owns every write.
import {
  applyFilter,
  emailVetoedForFolder,
  labelOf,
  matchByFiltersExplained,
  type CandidateTrace,
  type EmailForFilter,
} from "./filter-engine";
import type { AccountContext } from "./account-context";
import type { ClassificationResult, ParsedEmailForClassify } from "./classify";
import type { OverrideException } from "./types";
import { emailDomain } from "../company-domains";

/** Which door the email came through. Precedence does not vary by
 * trigger — this is recorded in the trace and decides which inputs are
 * available (a label change carries a label; a manual move carries an
 * explicit destination). */
export type DecisionTrigger =
  | "arrival"
  | "label_change"
  | "backfill"
  | "rescue"
  | "reanalyze"
  | "manual";

export const DECISION_TRACE_VERSION = 1 as const;

export type TraceStep = {
  /** Which rung of the ladder this is. */
  rung:
    | "override"
    | "gmail_label"
    | "filters"
    | "calendar_guard"
    | "ai"
    | "surface"
    | "manual"
    | "none";
  /** applied = this rung decided the outcome; skipped = it fired but was
   * overruled; pass = it had nothing to say. */
  outcome: "applied" | "skipped" | "pass";
  /** Config-level explanation. Never email content. */
  detail?: string;
};

/** The full "why" for one decision. Folder names and rule config only —
 * safe to store unencrypted and render directly. */
export type DecisionTrace = {
  version: typeof DECISION_TRACE_VERSION;
  trigger: DecisionTrigger;
  decided_at: string | null;
  steps: TraceStep[];
  /** Every folder that was considered, and how it fared. */
  candidates: CandidateTrace[];
  /** Why the winner beat the other matching folders. */
  tiebreak?: string;
  /** Populated once the AI rung runs (apply-decision fills this in). */
  ai?: {
    suggested_folder_id: string | null;
    suggested_folder_name: string | null;
    confidence: number;
    threshold: number;
    accepted: boolean;
  };
};

export type FolderDecision = ClassificationResult & {
  /** No rule fired and there are AI-eligible folders — provisional. */
  needs_ai: boolean;
  /** Rules filed this into a folder carrying a surface_ai_rule. */
  needs_surface_check: boolean;
  /** Optional so hand-built fixtures and older results stay assignable;
   * decideFolder always populates it. */
  trace?: DecisionTrace;
};

export type DecideOptions = {
  trigger: DecisionTrigger;
  /** Prior messages of the same thread, for folders with run_on_threads. */
  threadEmails?: EmailForFilter[];
  /** Ignore the message's Gmail labels (reanalyze re-derives from rules). */
  skipGmailLabelMatch?: boolean;
  /** trigger="label_change": the folder whose Gmail label just appeared.
   * It enters the ladder at rung 4 like any label match — so pause,
   * vetoes and overrides above it still apply, which is exactly what the
   * old mirror skipped. */
  labeledFolderId?: string | null;
  /** trigger="manual": the destination the user picked. A manual move is
   * a deliberate hard override of rungs 2-9, but it still respects rung 1
   * (a paused folder is not a destination). */
  manualFolderId?: string | null;
  /** Reason text for a manual move, so the UI keeps the user's words. */
  manualReason?: string | null;
};

const emptyResult = (): ClassificationResult => ({
  folder_id: null,
  classified_by: "none",
  ai_confidence: 0,
  ai_summary: "",
  classification_reason: null,
  matched_filter_ids: [],
  matched_folder_ids: [],
});

/** Build the candidate list for triggers that never run the filter engine
 * (manual moves), so their trace still shows pause verdicts. */
function candidatesFromFolders(context: AccountContext): CandidateTrace[] {
  return context.folders.map((f) => ({
    folder_id: f.id,
    folder_name: f.name,
    priority: f.priority,
    verdict: f.processing_enabled === false ? ("paused" as const) : ("no_match" as const),
    matched: [],
  }));
}

export function decideFolder(
  parsed: ParsedEmailForClassify,
  context: AccountContext,
  opts: DecideOptions,
): FolderDecision {
  const folderList = context.folders;
  const steps: TraceStep[] = [];
  const out = emptyResult();

  const fromAddr = (parsed.from_addr || "").toLowerCase();
  // Must use the same derivation the override WRITER uses
  // (gmail/move.functions.ts), or a domain override stored from a malformed
  // sender can never match the domain computed here and silently never fires.
  const fromDomain = emailDomain(parsed.from_addr) ?? "";
  // Attach sender_in_group hits so applyFilter can evaluate
  // `sender_in_group` conditions without a second DB round trip.
  if (!parsed.sender_group_ids) {
    const hits = context.senderGroups.get(fromAddr);
    parsed.sender_group_ids = hits ? Array.from(hits) : [];
  }

  const paused = (id: string | null | undefined) =>
    !!id && folderList.find((f) => f.id === id)?.processing_enabled === false;

  // ── Rung 1 + manual short-circuit ──────────────────────────────────
  if (opts.trigger === "manual" && opts.manualFolderId) {
    const target = folderList.find((f) => f.id === opts.manualFolderId);
    if (paused(opts.manualFolderId)) {
      steps.push({
        rung: "manual",
        outcome: "skipped",
        detail: `"${target?.name ?? "folder"}" is paused — filing skipped`,
      });
      return {
        ...out,
        classified_by: "none",
        classification_reason: `Not filed: "${target?.name ?? "folder"}" has filtering & rules paused`,
        needs_ai: false,
        needs_surface_check: false,
        trace: {
          version: DECISION_TRACE_VERSION,
          trigger: opts.trigger,
          decided_at: null,
          steps,
          candidates: candidatesFromFolders(context),
        },
      };
    }
    steps.push({
      rung: "manual",
      outcome: "applied",
      detail: `Moved to "${target?.name ?? "folder"}" by you`,
    });
    return {
      ...out,
      folder_id: opts.manualFolderId,
      classified_by: "manual_move",
      ai_confidence: 1,
      classification_reason: opts.manualReason ?? `Moved to "${target?.name ?? "folder"}" manually`,
      needs_ai: false,
      needs_surface_check: false,
      trace: {
        version: DECISION_TRACE_VERSION,
        trigger: opts.trigger,
        decided_at: null,
        steps,
        candidates: candidatesFromFolders(context),
        tiebreak: "You chose this folder — rules were not consulted",
      },
    };
  }

  // ── Rung 3 (inputs): always-inbox override + its exceptions ────────
  const overrideHit = context.overrides.find((o) => {
    const val = (o.value || "").toLowerCase();
    return o.match_type === "email" ? val === fromAddr : val === fromDomain;
  });
  let overrideExceptionHit: OverrideException | null = null;
  if (overrideHit) {
    const exForThisOverride = context.overrideExceptions.filter(
      (e) => e.override_id === overrideHit.id,
    );
    for (const ex of exForThisOverride) {
      if (
        applyFilter(parsed, { id: "", folder_id: "", field: ex.field, op: ex.op, value: ex.value })
      ) {
        overrideExceptionHit = ex;
        break;
      }
    }
  }

  // ── Rung 4 (inputs): linked Gmail label ────────────────────────────
  // A label_change trigger names the folder explicitly; every other
  // trigger reads it off the message's labels. Both go through the same
  // rungs from here down — that is the whole point of this module.
  const labelCandidateId = opts.skipGmailLabelMatch
    ? null
    : opts.trigger === "label_change"
      ? (opts.labeledFolderId ?? null)
      : (folderList.find((f) => f.gmail_label_id && parsed.raw_labels?.includes(f.gmail_label_id))
          ?.id ?? null);
  let labeledFolder = labelCandidateId
    ? (folderList.find((f) => f.id === labelCandidateId) ?? null)
    : null;

  // Rung 1: a paused folder is never a destination, not even for a label
  // Gmail itself applied. (The old mirror wrote folder_id anyway.)
  if (labeledFolder && labeledFolder.processing_enabled === false) {
    steps.push({
      rung: "gmail_label",
      outcome: "skipped",
      detail: `"${labeledFolder.name}" is paused — its Gmail label does not file mail`,
    });
    labeledFolder = null;
  }
  // Rung 2: the folder's own exclusion / allowlist rules veto it, even
  // when the label says otherwise.
  if (labeledFolder && emailVetoedForFolder(parsed, labeledFolder.id, context.filters)) {
    steps.push({
      rung: "gmail_label",
      outcome: "skipped",
      detail: `"${labeledFolder.name}" excludes this sender by its own rule`,
    });
    labeledFolder = null;
  }

  // ── Rung 5 (inputs): the filter engine ─────────────────────────────
  const explained = matchByFiltersExplained(
    parsed,
    opts.threadEmails ?? [],
    folderList,
    context.filters,
  );
  const folderMatch = labeledFolder ? null : explained.match;
  const candidates = explained.candidates;

  const beatingFolderId =
    overrideHit && folderMatch?.kind === "match"
      ? (folderMatch.all_matched_folder_ids.find(
          (fid) => folderList.find((x) => x.id === fid)?.overrides_inbox_override === true,
        ) ?? null)
      : null;
  const labelBeatsOverride =
    !!overrideHit && !!labeledFolder && labeledFolder.overrides_inbox_override === true;

  const overrideWins =
    !!overrideHit && !overrideExceptionHit && !beatingFolderId && !labelBeatsOverride;

  let aiSkipped = false;
  let tiebreak: string | undefined;

  if (overrideWins) {
    out.classified_by = "inbox_override";
    out.classification_reason = `Global inbox list: ${overrideHit!.match_type} "${overrideHit!.value}"`;
    aiSkipped = true;
    steps.push({
      rung: "override",
      outcome: "applied",
      detail: `Always-inbox rule on ${overrideHit!.match_type} "${overrideHit!.value}"`,
    });
  } else {
    if (overrideHit) {
      steps.push({
        rung: "override",
        outcome: "skipped",
        detail: overrideExceptionHit
          ? `Exception: ${overrideExceptionHit.field} ${overrideExceptionHit.op} "${overrideExceptionHit.value}"`
          : "A folder is set to beat your always-inbox list",
      });
    } else {
      steps.push({ rung: "override", outcome: "pass" });
    }

    if (labeledFolder) {
      out.folder_id = labeledFolder.id;
      out.classified_by = opts.trigger === "label_change" ? "gmail_labeled" : "gmail_label";
      out.ai_confidence = 1;
      out.classification_reason =
        opts.trigger === "label_change"
          ? `You labeled this "${labeledFolder.name}" in Gmail`
          : `Already labeled "${labeledFolder.name}" in Gmail at sync time`;
      steps.push({
        rung: "gmail_label",
        outcome: "applied",
        detail: `Gmail label maps to "${labeledFolder.name}"`,
      });
    } else {
      const m = folderMatch;
      // If a beatingFolder forced us past the override, prefer that folder
      // even if the priority sort picked a different one.
      const winningFolderId = beatingFolderId ?? (m?.kind === "match" ? m.folder_id : null);
      if (m?.kind === "match" && winningFolderId) {
        out.folder_id = winningFolderId;
        out.matched_folder_ids = m.all_matched_folder_ids;
        out.ai_confidence = 1;
        if (m.tree_used) {
          out.classified_by = "filter";
          out.classification_reason = `Rule group matched for "${labelOf(folderList, winningFolderId)}"`;
        } else if (m.filter) {
          out.classified_by = m.filter.field === "domain" ? "domain_rule" : "filter";
          out.matched_filter_ids = m.matched_filters.map((f) => f.id);
          out.classification_reason =
            out.classified_by === "domain_rule"
              ? `Domain rule: ${m.filter.value} → ${labelOf(folderList, winningFolderId)}`
              : `Filter: ${m.filter.field} ${m.filter.op} "${m.filter.value}"`;
        }
        if (m.matched_via_thread) {
          out.classification_reason =
            (out.classification_reason ?? "") + " (matched an earlier message in this thread)";
        }
        if (beatingFolderId && overrideHit) {
          out.classification_reason =
            (out.classification_reason ?? "") + ` (beat inbox override "${overrideHit.value}")`;
        } else if (overrideExceptionHit && overrideHit) {
          out.classification_reason =
            (out.classification_reason ?? "") +
            ` (exception to inbox override "${overrideHit.value}": ${overrideExceptionHit.field} ${overrideExceptionHit.op} "${overrideExceptionHit.value}")`;
        }
        steps.push({
          rung: "filters",
          outcome: "applied",
          detail: `Rules of "${labelOf(folderList, winningFolderId)}" matched`,
        });
        if (m.all_matched_folder_ids.length > 1) {
          tiebreak = `${m.all_matched_folder_ids.length} folders matched — highest priority won`;
        }

        // Rung 6. Calendar cold-email guard: known calendar contacts must
        // never be routed into a folder flagged is_cold_email.
        if (context.calendarGuardEnabled && context.calendarContacts.has(fromAddr)) {
          const winningFolder = folderList.find((f) => f.id === winningFolderId);
          if (winningFolder?.is_cold_email) {
            out.folder_id = null;
            out.classified_by = "calendar_contact";
            out.classification_reason = `Known calendar contact — not routed to "${winningFolder.name}"`;
            steps.push({
              rung: "calendar_guard",
              outcome: "applied",
              detail: `Sender is a calendar contact — kept out of cold-email folder "${winningFolder.name}"`,
            });
          }
        }
      } else if (m?.kind === "excluded") {
        out.classified_by = "excluded";
        out.classification_reason = `Would match "${m.folder_name}" but excluded by rule: ${m.exclude.field} ${m.exclude.op} "${m.exclude.value}"`;
        aiSkipped = true;
        steps.push({
          rung: "filters",
          outcome: "skipped",
          detail: `"${m.folder_name}" vetoed by ${m.exclude.field} ${m.exclude.op} "${m.exclude.value}"`,
        });
      } else {
        steps.push({ rung: "filters", outcome: "pass" });
        if (overrideExceptionHit && overrideHit) {
          // Exception fired but no folder matched — fall through to AI.
          out.classification_reason = `Inbox override "${overrideHit.value}" bypassed by exception (${overrideExceptionHit.field} ${overrideExceptionHit.op} "${overrideExceptionHit.value}")`;
        }
      }
    }
  }

  // ── Rung 7 (eligibility): who the AI may even consider ─────────────
  const aiFolders = aiCandidateIds(parsed, context);
  const needs_ai = !out.folder_id && !aiSkipped && folderList.length > 0 && aiFolders.size > 0;
  if (needs_ai) {
    steps.push({
      rung: "ai",
      outcome: "pass",
      detail: `${aiFolders.size} folder${aiFolders.size === 1 ? "" : "s"} eligible for AI`,
    });
  }

  // ── Rung 8 (eligibility): surface-to-inbox ─────────────────────────
  const routedFolder = out.folder_id ? folderList.find((f) => f.id === out.folder_id) : null;
  const needs_surface_check =
    !!out.folder_id &&
    !!routedFolder?.surface_ai_rule &&
    routedFolder.surface_ai_rule.trim().length > 0;

  if (!out.folder_id && !needs_ai) {
    steps.push({ rung: "none", outcome: "applied", detail: "Nothing matched — stays in inbox" });
  }

  return {
    ...out,
    needs_ai,
    needs_surface_check,
    trace: {
      version: DECISION_TRACE_VERSION,
      trigger: opts.trigger,
      decided_at: null,
      steps,
      candidates,
      ...(tiebreak ? { tiebreak } : {}),
    },
  };
}

/** AI-eligible folder ids. A folder is only considered by the AI when the
 * user gave it intent (non-empty ai_rule), it isn't paused, isn't
 * skip_ai, and the email doesn't violate the folder's own exclusion
 * rules — the AI must never place mail where the folder's rules reject
 * it. */
export function aiCandidateIds(
  parsed: ParsedEmailForClassify,
  context: AccountContext,
): Set<string> {
  const ids = new Set<string>();
  for (const f of context.folders) {
    if (f.processing_enabled === false) continue;
    if (f.skip_ai) continue;
    if ((f.ai_rule ?? "").trim().length === 0) continue;
    if (emailVetoedForFolder(parsed, f.id, context.filters)) continue;
    ids.add(f.id);
  }
  return ids;
}

/** Record the AI rung's outcome on an existing trace. Called by the async
 * AI pass so the stored trace explains the confidence decision. */
export function withAiStep(
  trace: DecisionTrace,
  ai: NonNullable<DecisionTrace["ai"]>,
): DecisionTrace {
  return {
    ...trace,
    ai,
    steps: [
      ...trace.steps.filter((s) => s.rung !== "ai"),
      {
        rung: "ai",
        outcome: ai.accepted ? "applied" : "skipped",
        detail: ai.suggested_folder_name
          ? `AI suggested "${ai.suggested_folder_name}" at ${Math.round(ai.confidence * 100)}% (needs ${Math.round(ai.threshold * 100)}%)`
          : "AI found no matching folder",
      },
    ],
  };
}

/** Record the surface-to-inbox rung's outcome on an existing trace. */
export function withSurfaceStep(
  trace: DecisionTrace,
  surfaced: boolean,
  reason: string,
): DecisionTrace {
  return {
    ...trace,
    steps: [
      ...trace.steps.filter((s) => s.rung !== "surface"),
      {
        rung: "surface",
        outcome: surfaced ? "applied" : "pass",
        detail: surfaced
          ? reason || "Kept visible in your inbox by the folder's surface rule"
          : "Surface rule did not apply",
      },
    ],
  };
}
