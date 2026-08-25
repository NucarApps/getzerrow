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
export * from "./types";
