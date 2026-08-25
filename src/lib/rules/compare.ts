// Shadow comparison (Phase E).
//
// While the amended engine runs alongside the legacy ladder, every message
// produces two answers. This module turns the pair into one small,
// loggable verdict: do they agree, and if not, which stage explains the
// difference. Content never enters the verdict — folder ids, stage names
// and classifier labels only, so it is safe to log.
//
// PURE: no Supabase, no clock.
import type { EvaluateResult, Stage } from "./types";

export type LegacyDecisionSummary = {
  folder_id: string | null;
  classified_by: string;
  needs_ai: boolean;
};

export type ShadowVerdict = {
  agree: boolean;
  /** True when both engines defer to AI, so neither has decided yet. */
  both_defer_to_ai: boolean;
  legacy_folder_id: string | null;
  engine_folder_id: string | null;
  legacy_classified_by: string;
  engine_stage: Stage;
  engine_needs_ai: boolean;
  /** Short, content-free explanation of the difference. */
  detail: string;
};

/** Legacy classifier labels that mean "deterministic rules filed this". */
const RULE_LABELS = new Set(["filter", "domain_rule", "tree", "rule"]);

export function compareDecisions(
  legacy: LegacyDecisionSummary,
  engine: EvaluateResult,
): ShadowVerdict {
  const bothDefer = legacy.needs_ai && engine.needs_ai;
  const agree = legacy.folder_id === engine.folder_id;

  const detail = (() => {
    if (agree) return bothDefer ? "both defer to AI" : "same destination";
    if (legacy.folder_id === null) {
      return `engine files where legacy kept inbox (stage ${engine.stage})`;
    }
    if (engine.folder_id === null) {
      return engine.needs_ai
        ? `engine defers to AI where legacy filed by ${legacy.classified_by}`
        : `engine keeps inbox where legacy filed by ${legacy.classified_by}`;
    }
    return `different folder: legacy by ${legacy.classified_by}, engine by ${engine.stage}`;
  })();

  return {
    agree,
    both_defer_to_ai: bothDefer,
    legacy_folder_id: legacy.folder_id,
    engine_folder_id: engine.folder_id,
    legacy_classified_by: legacy.classified_by,
    engine_stage: engine.stage,
    engine_needs_ai: engine.needs_ai,
    detail,
  };
}

/** Map an engine stage onto the `classified_by` vocabulary the UI, the
 * inbox filters and the existing analytics already understand. */
export function classifiedByForStage(stage: Stage): string {
  switch (stage) {
    case "guardrail":
      return "excluded";
    case "pin":
      return "global_exclude";
    case "gmail_label":
      return "gmail_label";
    case "thread_continuity":
      return "thread_continuity";
    case "rule":
      return "filter";
    case "ai":
      return "ai";
    default:
      return "none";
  }
}

/** True when a legacy label means the deterministic rule stage decided. */
export const isRuleLabel = (label: string): boolean => RULE_LABELS.has(label);
