// Phase E cutover stage: run the amended engine on the live path.
//
// One function sits between the legacy ladder and the AI passes:
//
//   mode "off"    — legacy result, untouched.
//   mode "shadow" — legacy result decides, the engine runs alongside and
//                   every disagreement is logged with folder ids and stage
//                   names only. Default.
//   mode "on"     — the engine's deterministic decision is returned, with
//                   its v2 trace attached for storage.
//
// The AI stage is never run here: classify.ts owns the async passes, so
// this stage always evaluates with aiEnabled=false and reports needs_ai.
import { logInfo, logMetric } from "../log.server";
import { classifiedByForStage, compareDecisions } from "../rules/compare";
import { runRulesEngine } from "../rules/bridge";
import { rulesEngineMode } from "../rules/mode.server";
import { levelLabel } from "../rules/specificity";
import type { AccountContext } from "./account-context";
import type { ParsedEmailForClassify } from "./classify";
import type { FolderDecision } from "./decide-folder";
import type { EmailForFilter } from "./filter-engine";

export function runEngineStage(
  parsed: ParsedEmailForClassify,
  context: AccountContext,
  legacy: FolderDecision,
  opts: { skipGmailLabelMatch?: boolean; threadEmails?: EmailForFilter[] } = {},
): FolderDecision {
  const mode = rulesEngineMode();
  if (mode === "off") return legacy;

  let engine;
  try {
    engine = runRulesEngine(parsed, context, {
      trigger: "arrival",
      aiEnabled: false,
      skipGmailLabelMatch: opts.skipGmailLabelMatch,
      threadEmails: opts.threadEmails,
    });
  } catch (e) {
    // The engine must never be able to stop mail from being filed. A
    // failure here degrades to the legacy answer and is loud in the logs.
    logInfo("rules_engine.failed", {
      mode,
      error: e instanceof Error ? e.message : "unknown",
    });
    return legacy;
  }

  const verdict = compareDecisions(
    {
      folder_id: legacy.folder_id,
      classified_by: legacy.classified_by,
      needs_ai: legacy.needs_ai,
    },
    engine,
  );

  logMetric("rules_engine.compare", {
    mode,
    agree: verdict.agree,
    engine_stage: verdict.engine_stage,
    legacy_classified_by: verdict.legacy_classified_by,
  });
  if (!verdict.agree) {
    logInfo("rules_engine.disagreement", {
      mode,
      detail: verdict.detail,
      legacy_folder_id: verdict.legacy_folder_id,
      engine_folder_id: verdict.engine_folder_id,
      engine_stage: verdict.engine_stage,
      engine_needs_ai: verdict.engine_needs_ai,
    });
  }
  if (engine.trace.collision) {
    logInfo("rules_engine.collision", {
      mode,
      level: engine.trace.collision.level,
      winner_rule_id: engine.trace.collision.winner_rule_id,
      loser_rule_ids: engine.trace.collision.loser_rule_ids,
    });
  }

  if (mode === "shadow") return legacy;

  // Authoritative: translate the engine's decision into the result shape
  // the rest of the pipeline (side effects, UI, analytics) already reads.
  const winner = engine.trace.winner;
  const matchedFolderIds = Array.from(
    new Set(engine.trace.matched_rules.map((r) => r.folder_id)),
  );
  const matchedRuleIds = engine.trace.matched_rules
    .filter((r) => r.folder_id === engine.folder_id)
    .map((r) => r.rule_id)
    // Adapted tree rules carry synthetic ids; only real folder_filters
    // rows belong in matched_filter_ids.
    .filter((id) => !id.startsWith("tree:") && !id.startsWith("all:"));

  const reason = winner
    ? `${levelLabel(winner.level)} rule matched — ${winner.reason}`
    : engine.reason;

  return {
    ...legacy,
    folder_id: engine.folder_id,
    classified_by: engine.needs_ai ? legacy.classified_by : classifiedByForStage(engine.stage),
    classification_reason: reason,
    matched_folder_ids: matchedFolderIds,
    matched_filter_ids: matchedRuleIds,
    needs_ai: engine.needs_ai,
    // A surface check only makes sense for a folder the engine actually
    // chose; otherwise the legacy flag would fire for the wrong folder.
    needs_surface_check:
      legacy.needs_surface_check && engine.folder_id !== null
        ? engine.folder_id === legacy.folder_id
        : false,
    rules_trace: engine.trace,
  };
}
