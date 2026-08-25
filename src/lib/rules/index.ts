// Public surface of the rules engine (Phase B). Pure logic only — import
// this from anywhere, including the client, without pulling Supabase or
// the AI gateway into the graph.
export { evaluate, aiCandidateFolderIds } from "./evaluate";
export { resolveRules, evaluateRule, compareRules } from "./resolve";
export { evaluateGuardrails, isSecurityMessage, describeCondition } from "./guardrails";
export {
  conditionLevel,
  deriveRuleLevel,
  ruleLevel,
  ruleConditionCount,
  levelLabel,
  LEVEL_LABELS,
} from "./specificity";
export { toRules, toGuardrails, toPins, toEngineFolder, treeToGroups } from "./adapt";
// Phase D: save-time collision checking and replay change-sets.
export { checkRuleConflicts, MAX_CONFLICT_SAMPLES } from "./conflicts";
export type { ConflictKind, ConflictReport, RuleConflict, SampleMessage } from "./conflicts";
export { buildChangeSet, autoApplicableIds, describeChangeSet, INBOX_LABEL } from "./replay";
export type { ChangeEntry, ChangeSet, ReplayMessage } from "./replay";
export * from "./types";
