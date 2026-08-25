// Reading a stored decision back (Phase C).
//
// `emails.decision_trace` is plain jsonb written by two generations of the
// engine: v1 traces from src/lib/sync/decide-folder.ts and v2 traces from
// this engine (RULES_TRACE_VERSION). Nothing here trusts the column shape:
// every field is narrowed before it reaches the UI, so a hand-edited row or
// a trace written by an older build renders as "no detail recorded" rather
// than crashing the drawer.
//
// PURITY: no Supabase, no clock. Parsing and labelling only.
import { levelLabel } from "./specificity";
import {
  RULES_TRACE_VERSION,
  type Collision,
  type ConditionCheck,
  type RuleEvaluation,
  type RulesTrace,
  type SpecificityLevel,
  type Stage,
  type StageTrace,
  type Trigger,
} from "./types";

const STAGES: Stage[] = [
  "guardrail",
  "pin",
  "gmail_label",
  "thread_continuity",
  "rule",
  "ai",
  "inbox",
];

const TRIGGERS: Trigger[] = [
  "arrival",
  "label_change",
  "backfill",
  "reprocess",
  "replay",
  "manual",
];

/** Plain-language name for each pipeline stage, in ladder order. */
export const STAGE_LABELS: Record<Stage, string> = {
  guardrail: "Guardrails and exclusions",
  pin: "Your pins",
  gmail_label: "Gmail label",
  thread_continuity: "Thread continuity",
  rule: "Rules",
  ai: "AI",
  inbox: "Inbox",
};

export const TRIGGER_LABELS: Record<Trigger, string> = {
  arrival: "on arrival",
  label_change: "when you labeled it in Gmail",
  backfill: "during backfill",
  reprocess: "during a reprocess",
  replay: "during a rule replay",
  manual: "when you moved it",
};

/** The ladder order every stage list renders in. */
export const STAGE_ORDER: readonly Stage[] = STAGES;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function asLevel(v: unknown): SpecificityLevel | null {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? v : null;
}

function parseStage(v: unknown): StageTrace | null {
  if (!isRecord(v)) return null;
  const stage = STAGES.find((s) => s === v.stage);
  const outcome = v.outcome;
  if (!stage || (outcome !== "applied" && outcome !== "skipped" && outcome !== "pass")) return null;
  const detail = str(v.detail);
  return detail ? { stage, outcome, detail } : { stage, outcome };
}

function parseConditions(v: unknown): ConditionCheck[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((c) => {
    if (!isRecord(c)) return [];
    const field = str(c.field);
    const op = str(c.op);
    if (!field || !op) return [];
    return [{ field, op, value: str(c.value) ?? "", passed: c.passed === true }];
  });
}

function parseRuleEvaluation(v: unknown): RuleEvaluation | null {
  if (!isRecord(v)) return null;
  const level = asLevel(v.level);
  const ruleId = str(v.rule_id);
  const folderId = str(v.folder_id);
  if (!level || !ruleId || !folderId) return null;
  return {
    rule_id: ruleId,
    folder_id: folderId,
    folder_name: str(v.folder_name) ?? "folder",
    level,
    matched: v.matched === true,
    condition_count:
      typeof v.condition_count === "number" ? v.condition_count : parseConditions(v.conditions).length,
    conditions: parseConditions(v.conditions),
  };
}

function parseCollision(v: unknown): Collision | undefined {
  if (!isRecord(v)) return undefined;
  const level = asLevel(v.level);
  const winner = str(v.winner_rule_id);
  if (!level || !winner) return undefined;
  return {
    level,
    winner_rule_id: winner,
    loser_rule_ids: strArray(v.loser_rule_ids),
    folder_ids: strArray(v.folder_ids),
    reason: str(v.reason) ?? "",
  };
}

/** Narrow a stored `decision_trace` value into a v2 RulesTrace, or null
 * when the column is empty, malformed, or holds a v1 trace. */
export function parseRulesTrace(raw: unknown): RulesTrace | null {
  if (!isRecord(raw) || raw.version !== RULES_TRACE_VERSION) return null;
  const trigger = TRIGGERS.find((t) => t === raw.trigger) ?? "arrival";
  const winnerRaw = isRecord(raw.winner) ? raw.winner : null;
  const winnerLevel = winnerRaw ? asLevel(winnerRaw.level) : null;
  const aiRaw = isRecord(raw.ai) ? raw.ai : null;

  return {
    version: RULES_TRACE_VERSION,
    trigger,
    stages: Array.isArray(raw.stages)
      ? raw.stages.map(parseStage).filter((s): s is StageTrace => s !== null)
      : [],
    matched_rules: Array.isArray(raw.matched_rules)
      ? raw.matched_rules.map(parseRuleEvaluation).filter((r): r is RuleEvaluation => r !== null)
      : [],
    failed_rules: Array.isArray(raw.failed_rules)
      ? raw.failed_rules.map(parseRuleEvaluation).filter((r): r is RuleEvaluation => r !== null)
      : [],
    vetoed_folder_ids: strArray(raw.vetoed_folder_ids),
    ...(winnerRaw && winnerLevel && str(winnerRaw.rule_id) && str(winnerRaw.folder_id)
      ? {
          winner: {
            rule_id: str(winnerRaw.rule_id) as string,
            folder_id: str(winnerRaw.folder_id) as string,
            level: winnerLevel,
            reason: str(winnerRaw.reason) ?? "",
          },
        }
      : {}),
    ...(parseCollision(raw.collision) ? { collision: parseCollision(raw.collision) } : {}),
    ...(aiRaw
      ? {
          ai: {
            eligible_folder_ids: strArray(aiRaw.eligible_folder_ids),
            enabled: aiRaw.enabled === true,
          },
        }
      : {}),
  };
}

/** True when the stored value is a v1 trace from the previous engine.
 * The UI shows those through the legacy panel instead. */
export function isLegacyTrace(raw: unknown): boolean {
  return isRecord(raw) && raw.version === 1;
}

/** The stage that actually decided the outcome, if the trace recorded one. */
export function decidingStage(trace: RulesTrace): StageTrace | null {
  return trace.stages.find((s) => s.outcome === "applied") ?? null;
}

/** One-line summary for the drawer header, e.g.
 * "L2 exact domain rule decided this on arrival". */
export function traceHeadline(trace: RulesTrace): string {
  const decided = decidingStage(trace);
  const when = TRIGGER_LABELS[trace.trigger];
  if (!decided) return `Evaluated ${when} — no stage claimed it`;
  if (decided.stage === "rule" && trace.winner) {
    return `${levelLabel(trace.winner.level)} rule decided this ${when}`;
  }
  return `${STAGE_LABELS[decided.stage]} decided this ${when}`;
}

/** Stage rows in ladder order, including stages the trace never reached
 * (rendered as "not reached" by the UI). */
export function stageRows(
  trace: RulesTrace,
): Array<{ stage: Stage; label: string; outcome: StageTrace["outcome"] | "not_reached"; detail?: string }> {
  const byStage = new Map(trace.stages.map((s) => [s.stage, s]));
  return STAGES.map((stage) => {
    const hit = byStage.get(stage);
    return {
      stage,
      label: STAGE_LABELS[stage],
      outcome: hit?.outcome ?? ("not_reached" as const),
      ...(hit?.detail ? { detail: hit.detail } : {}),
    };
  });
}
