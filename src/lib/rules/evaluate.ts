// THE decision. One pure pipeline, evaluated once per message, first
// decision wins (Amendment 1):
//
//   1. Guardrails and exclusions  security codes, 2FA, protected senders,
//                                 matching exclusions -> Inbox, stop
//   2. Pins                       explicit per-sender / per-thread pins
//   3. Gmail label mirror         folder linked to a label Gmail applied
//   4. Thread continuity          earlier user / confirmed placement
//   5. Hard rules                 specificity ladder (no manual ordering)
//   6. AI fallback                only when stage 5 returned nothing, and
//                                 only when aiEnabled
//   7. Inbox                      nothing matched
//
// Backfill, reprocess and replay call this same function with
// aiEnabled: false. No other code path may decide a folder.
//
// PURITY: no Supabase, no AI, no clock. Same inputs -> same decision ->
// same trace.
import { emailDomain } from "../company-domains";
import { evaluateGuardrails, isSecurityMessage } from "./guardrails";
import { resolveRules } from "./resolve";
import { levelLabel } from "./specificity";
import {
  RULES_TRACE_VERSION,
  type EngineFolder,
  type EngineMessage,
  type EvaluateContext,
  type EvaluateOptions,
  type EvaluateResult,
  type Pin,
  type RulesTrace,
  type StageTrace,
} from "./types";

function nameOf(folders: EngineFolder[], id: string | null | undefined): string {
  return folders.find((f) => f.id === id)?.name ?? "folder";
}

function isPaused(folders: EngineFolder[], id: string | null | undefined): boolean {
  return !!id && folders.find((f) => f.id === id)?.processing_enabled === false;
}

function pinMatches(m: EngineMessage, pin: Pin): boolean {
  const value = (pin.value || "").toLowerCase().replace(/^@/, "");
  if (pin.match === "thread") return !!m.thread_id && m.thread_id === pin.value;
  if (pin.match === "email") return value === (m.from_addr || "").toLowerCase();
  return value === (emailDomain(m.from_addr) ?? "");
}

/** Folders the AI stage may consider: not paused, not vetoed, not opted
 * out, and carrying something to score against. */
export function aiCandidateFolderIds(folders: EngineFolder[], vetoedFolderIds: string[]): string[] {
  const vetoed = new Set(vetoedFolderIds);
  return folders
    .filter((f) => {
      if (f.processing_enabled === false || vetoed.has(f.id) || f.skip_ai) return false;
      const described = (f.description ?? "").trim().length > 0;
      const learned = (f.learned_profile ?? "").trim().length > 0;
      return described || learned;
    })
    .map((f) => f.id);
}

export function evaluate(
  message: EngineMessage,
  context: EvaluateContext,
  opts: EvaluateOptions,
): EvaluateResult {
  const stages: StageTrace[] = [];
  const folders = context.folders;

  const finish = (
    folderId: string | null,
    stage: EvaluateResult["stage"],
    reason: string,
    extra: Partial<RulesTrace> = {},
    needsAi = false,
    aiCandidates: string[] = [],
  ): EvaluateResult => ({
    folder_id: folderId,
    stage,
    needs_ai: needsAi,
    ai_candidate_folder_ids: aiCandidates,
    reason,
    trace: {
      version: RULES_TRACE_VERSION,
      trigger: opts.trigger,
      stages,
      matched_rules: [],
      failed_rules: [],
      vetoed_folder_ids: [],
      ...extra,
    },
  });

  // ── Stage 1: guardrails and exclusions ────────────────────────────────
  const guard = evaluateGuardrails(
    message,
    context.guardrails,
    context.isSecurityMessage ?? isSecurityMessage,
  );
  if (guard.verdict.kind !== "none") {
    stages.push({ stage: "guardrail", outcome: "applied", detail: guard.verdict.detail });
    return finish(null, "guardrail", guard.verdict.detail, {
      vetoed_folder_ids: guard.vetoedFolderIds,
    });
  }
  stages.push({
    stage: "guardrail",
    outcome: "pass",
    detail: guard.vetoedFolderIds.length
      ? `${guard.vetoedFolderIds.length} folder(s) excluded for this message`
      : undefined,
  });

  // ── Stage 2: pins ─────────────────────────────────────────────────────
  const pin = context.pins.find((p) => pinMatches(message, p));
  if (pin) {
    if (pin.kind === "inbox") {
      const detail = `You pinned ${pin.match === "thread" ? "this thread" : `"${pin.value}"`} to the Inbox`;
      stages.push({ stage: "pin", outcome: "applied", detail });
      return finish(null, "pin", detail, { vetoed_folder_ids: guard.vetoedFolderIds });
    }
    if (
      pin.folder_id &&
      !isPaused(folders, pin.folder_id) &&
      !guard.vetoedFolderIds.includes(pin.folder_id)
    ) {
      const detail = `You pinned ${pin.match === "thread" ? "this thread" : `"${pin.value}"`} to "${nameOf(folders, pin.folder_id)}"`;
      stages.push({ stage: "pin", outcome: "applied", detail });
      return finish(pin.folder_id, "pin", detail, { vetoed_folder_ids: guard.vetoedFolderIds });
    }
    stages.push({
      stage: "pin",
      outcome: "skipped",
      detail: `Pinned folder "${nameOf(folders, pin.folder_id)}" is paused or excluded here`,
    });
  } else {
    stages.push({ stage: "pin", outcome: "pass" });
  }

  // ── Stage 3: Gmail label mirror ───────────────────────────────────────
  const labeledId = opts.skipGmailLabelMatch
    ? null
    : opts.trigger === "label_change"
      ? (opts.labeledFolderId ?? null)
      : (folders.find(
          (f) => f.gmail_label_id && (message.raw_labels ?? []).includes(f.gmail_label_id),
        )?.id ?? null);

  if (labeledId) {
    if (isPaused(folders, labeledId)) {
      stages.push({
        stage: "gmail_label",
        outcome: "skipped",
        detail: `"${nameOf(folders, labeledId)}" is paused — its Gmail label does not file mail`,
      });
    } else if (guard.vetoedFolderIds.includes(labeledId)) {
      stages.push({
        stage: "gmail_label",
        outcome: "skipped",
        detail: `"${nameOf(folders, labeledId)}" excludes this message by its own rule`,
      });
    } else {
      const detail =
        opts.trigger === "label_change"
          ? `You labeled this "${nameOf(folders, labeledId)}" in Gmail`
          : `Already labeled "${nameOf(folders, labeledId)}" in Gmail`;
      stages.push({ stage: "gmail_label", outcome: "applied", detail });
      return finish(labeledId, "gmail_label", detail, {
        vetoed_folder_ids: guard.vetoedFolderIds,
      });
    }
  } else {
    stages.push({ stage: "gmail_label", outcome: "pass" });
  }

  // ── Stage 4: thread continuity ────────────────────────────────────────
  const prior = context.threadDecision ?? null;
  if (prior?.folder_id && (prior.provenance === "user" || prior.provenance === "confirmed")) {
    if (isPaused(folders, prior.folder_id) || guard.vetoedFolderIds.includes(prior.folder_id)) {
      stages.push({
        stage: "thread_continuity",
        outcome: "skipped",
        detail: `Earlier message went to "${nameOf(folders, prior.folder_id)}", which is paused or excluded here`,
      });
    } else {
      const detail = `An earlier message in this thread was filed to "${nameOf(folders, prior.folder_id)}" by you`;
      stages.push({ stage: "thread_continuity", outcome: "applied", detail });
      return finish(prior.folder_id, "thread_continuity", detail, {
        vetoed_folder_ids: guard.vetoedFolderIds,
      });
    }
  } else if (prior?.folder_id) {
    stages.push({
      stage: "thread_continuity",
      outcome: "skipped",
      detail:
        "Earlier message was filed by an unconfirmed AI decision — continuity does not chain off it",
    });
  } else {
    stages.push({ stage: "thread_continuity", outcome: "pass" });
  }

  // ── Stage 5: hard rules, specificity ladder ───────────────────────────
  const resolution = resolveRules(message, context.rules, folders, {
    vetoedFolderIds: guard.vetoedFolderIds,
    threadMessages: context.threadMessages,
  });

  const ruleTrace: Partial<RulesTrace> = {
    matched_rules: resolution.matched,
    failed_rules: resolution.failed,
    vetoed_folder_ids: guard.vetoedFolderIds,
    ...(resolution.collision ? { collision: resolution.collision } : {}),
  };

  if (resolution.winner) {
    const { rule, level, reason } = resolution.winner;
    const detail = `${levelLabel(level)} rule filed this to "${nameOf(folders, rule.folder_id)}" — ${reason}`;
    stages.push({ stage: "rule", outcome: "applied", detail });
    return finish(rule.folder_id, "rule", detail, {
      ...ruleTrace,
      winner: { rule_id: rule.id, folder_id: rule.folder_id, level, reason },
    });
  }
  stages.push({
    stage: "rule",
    outcome: "pass",
    detail: `${resolution.failed.length ? `${resolution.failed.length} rule(s) evaluated, none matched` : "No rules matched"}`,
  });

  // ── Stage 6: AI fallback ──────────────────────────────────────────────
  const aiCandidates = aiCandidateFolderIds(folders, guard.vetoedFolderIds);
  const needsAi = opts.aiEnabled && aiCandidates.length > 0;
  stages.push({
    stage: "ai",
    outcome: needsAi ? "pass" : "skipped",
    detail: opts.aiEnabled
      ? `${aiCandidates.length} folder(s) eligible for AI`
      : `AI is off for ${opts.trigger}`,
  });

  if (needsAi) {
    return finish(
      null,
      "ai",
      `No rule matched — ${aiCandidates.length} folder(s) eligible for AI`,
      { ...ruleTrace, ai: { eligible_folder_ids: aiCandidates, enabled: true } },
      true,
      aiCandidates,
    );
  }

  // ── Stage 7: Inbox ────────────────────────────────────────────────────
  stages.push({
    stage: "inbox",
    outcome: "applied",
    detail: "Nothing matched — stays in the Inbox",
  });
  return finish(null, "inbox", "Nothing matched — stays in the Inbox", {
    ...ruleTrace,
    ai: { eligible_folder_ids: aiCandidates, enabled: opts.aiEnabled },
  });
}
