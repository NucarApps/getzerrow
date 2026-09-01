// Stage 5: hard rules, resolved by the specificity ladder (Amendment 2).
//
// Deterministic, with no manual ordering anywhere:
//   1. most specific level wins (L1 beats L2 beats … beats L5)
//   2. inside a level, the rule with MORE conditions wins
//   3. still tied: the OLDER rule wins
//
// Runtime defense (Amendment 3): if two same-level rules with DIFFERENT
// folders both match, the older rule wins, and the resolution reports a
// collision so the caller can record an event and raise a fix card. Never
// silent, never priority-dependent.
import { applyFilter, EXCLUDE_OPS, filterVetoes } from "../sync/filter-engine";
import { ruleConditionCount, ruleLevel, levelLabel } from "./specificity";
import type {
  Collision,
  Condition,
  ConditionCheck,
  EngineFolder,
  EngineMessage,
  Rule,
  RuleEvaluation,
  SpecificityLevel,
} from "./types";
import { MAX_TRACED_FAILED_RULES } from "./types";

function checkCondition(m: EngineMessage, c: Condition): boolean {
  const f = { id: "", folder_id: "", field: c.field, op: c.op, value: c.value };
  // Inside a rule, a negative operator is an ordinary positive condition:
  // "subject does not contain invoice" passes when the subject does NOT
  // contain it, and "domain is one of …" passes when the domain IS listed.
  // filterVetoes answers the opposite (folder-level veto), so negate it.
  return EXCLUDE_OPS.has(c.op) ? !filterVetoes(m, f) : applyFilter(m, f);
}

type GroupCheck = { matched: boolean; checks: ConditionCheck[] };

function checkGroup(m: EngineMessage, group: Condition[]): GroupCheck {
  const checks = group.map((c) => ({ ...c, passed: checkCondition(m, c) }));
  return { matched: checks.length > 0 && checks.every((c) => c.passed), checks };
}

/** Evaluate one rule against the message (and, when supplied, the earlier
 * messages of its thread). A rule matches when every condition of at
 * least one OR group matches on the same message. */
export function evaluateRule(
  rule: Rule,
  m: EngineMessage,
  threadMessages: EngineMessage[] = [],
): { matched: boolean; checks: ConditionCheck[] } {
  let firstChecks: ConditionCheck[] = [];
  for (const candidate of [m, ...threadMessages]) {
    for (const group of rule.groups) {
      const res = checkGroup(candidate, group);
      if (firstChecks.length === 0) firstChecks = res.checks;
      if (res.matched) return { matched: true, checks: res.checks };
    }
  }
  return { matched: false, checks: firstChecks };
}

export type RuleResolution = {
  winner: { rule: Rule; level: SpecificityLevel; reason: string } | null;
  matched: RuleEvaluation[];
  failed: RuleEvaluation[];
  collision: Collision | null;
};

const olderFirst = (a: Rule, b: Rule) =>
  Date.parse(a.created_at || "") - Date.parse(b.created_at || "") || a.id.localeCompare(b.id);

/** Compare two matching rules under the ladder. Negative = `a` wins. */
export function compareRules(a: Rule, b: Rule): number {
  const byLevel = ruleLevel(a) - ruleLevel(b);
  if (byLevel !== 0) return byLevel;
  const byConditions = ruleConditionCount(b) - ruleConditionCount(a);
  if (byConditions !== 0) return byConditions;
  return olderFirst(a, b);
}

export function resolveRules(
  m: EngineMessage,
  rules: Rule[],
  folders: EngineFolder[],
  opts: { vetoedFolderIds?: string[]; threadMessages?: EngineMessage[] } = {},
): RuleResolution {
  const vetoed = new Set(opts.vetoedFolderIds ?? []);
  const nameOf = (id: string) => folders.find((f) => f.id === id)?.name ?? "folder";
  const paused = (id: string) => folders.find((f) => f.id === id)?.processing_enabled === false;

  const matched: RuleEvaluation[] = [];
  const failed: RuleEvaluation[] = [];
  const matchingRules: Rule[] = [];

  for (const rule of rules) {
    if (rule.enabled === false) continue;
    // A paused or vetoed folder is never a destination, so its rules are
    // not even evaluated — they cannot win and cannot collide.
    if (paused(rule.folder_id) || vetoed.has(rule.folder_id)) continue;

    const { matched: hit, checks } = evaluateRule(rule, m, opts.threadMessages);
    const evaluation: RuleEvaluation = {
      rule_id: rule.id,
      folder_id: rule.folder_id,
      folder_name: nameOf(rule.folder_id),
      level: ruleLevel(rule),
      matched: hit,
      condition_count: ruleConditionCount(rule),
      conditions: checks,
    };
    if (hit) {
      matched.push(evaluation);
      matchingRules.push(rule);
    } else if (failed.length < MAX_TRACED_FAILED_RULES) {
      failed.push(evaluation);
    }
  }

  if (matchingRules.length === 0) {
    return { winner: null, matched, failed, collision: null };
  }

  const sorted = [...matchingRules].sort(compareRules);
  const winner = sorted[0]!;
  const level = ruleLevel(winner);

  const sameLevel = sorted.filter((r) => ruleLevel(r) === level);
  const conflicting = sameLevel.filter((r) => r.folder_id !== winner.folder_id);

  const collision: Collision | null = conflicting.length
    ? {
        level,
        winner_rule_id: winner.id,
        loser_rule_ids: conflicting.map((r) => r.id),
        folder_ids: Array.from(new Set(sameLevel.map((r) => r.folder_id))),
        reason: `${sameLevel.length} ${levelLabel(level)} rules matched with different folders — the older rule won`,
      }
    : null;

  const reason = (() => {
    if (sorted.length === 1) return `Only ${levelLabel(level)} rule that matched`;
    const runnerUp = sorted[1]!;
    if (ruleLevel(runnerUp) !== level) {
      return `${levelLabel(level)} beats ${levelLabel(ruleLevel(runnerUp))}`;
    }
    if (ruleConditionCount(runnerUp) !== ruleConditionCount(winner)) {
      return `Same level — more conditions (${ruleConditionCount(winner)} vs ${ruleConditionCount(runnerUp)})`;
    }
    return "Same level and same number of conditions — the older rule won";
  })();

  return { winner: { rule: winner, level, reason }, matched, failed, collision };
}

export { levelLabel };
export type { Collision, RuleEvaluation };
