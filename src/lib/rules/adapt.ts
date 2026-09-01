// Adapters from today's stored shapes to the engine's inputs.
//
// The engine is pure and knows nothing about folder_filters,
// inbox_overrides or filter_tree. These functions translate, so the
// migration is a data mapping rather than an engine rewrite:
//
//   folder_filters (include ops) -> Rule[]      (one rule per condition,
//                                                or one rule per folder
//                                                when filter_logic="all")
//   folder_filters (exclude ops) -> Guardrail[] (folder-scoped)
//   folders.filter_tree          -> Rule.groups (OR of ANDs)
//   inbox_overrides              -> Pin[]       (kind: "inbox")
import { EXCLUDE_OPS } from "../sync/filter-engine";
import type { Filter, Folder, RuleNode } from "../sync/types";
import { deriveRuleLevel } from "./specificity";
import type { Condition, EngineFolder, Guardrail, Pin, Rule } from "./types";

const EPOCH = "1970-01-01T00:00:00.000Z";

export function toEngineFolder(f: Folder): EngineFolder {
  return {
    id: f.id,
    name: f.name,
    processing_enabled: f.processing_enabled,
    gmail_label_id: f.gmail_label_id,
    // `ai_rule` is the plain-language description today; Phase D renames
    // the column to `description`. Both are read here so the switch-over
    // needs no engine change.
    description: f.ai_rule,
    learned_profile: f.learned_profile,
    min_ai_confidence: f.min_ai_confidence,
    skip_ai: f.skip_ai,
  };
}

/** Flatten an OR-of-ANDs tree into condition groups. Nested groups are
 * flattened conservatively: an AND inside an OR becomes one group; deeper
 * mixes collapse into their leaves so a tree can never silently match
 * more than its authored intent. */
export function treeToGroups(node: RuleNode | null): Condition[][] {
  if (!node) return [];
  if (node.type === "cond") return [[{ field: node.field, op: node.op, value: node.value }]];
  const childGroups = node.children.map(treeToGroups);
  if (node.op === "or") return childGroups.flat();
  // AND: cross-product would explode, so concatenate the leaves of each
  // child group into a single conjunction.
  return [childGroups.flat().flat()];
}

/** Build the rule set for one account from folders + folder_filters. */
export function toRules(folders: Folder[], filters: Filter[]): Rule[] {
  const rules: Rule[] = [];

  for (const folder of folders) {
    const own = filters.filter((f) => f.folder_id === folder.id && !EXCLUDE_OPS.has(f.op));

    if (folder.filter_tree) {
      const groups = treeToGroups(folder.filter_tree).filter((g) => g.length > 0);
      if (groups.length) {
        rules.push(
          withLevel({ id: `tree:${folder.id}`, folder_id: folder.id, created_at: EPOCH, groups }),
        );
      }
    }

    if (own.length === 0) continue;

    if (folder.filter_logic === "all") {
      // One rule: every condition must hold.
      rules.push(
        withLevel({
          id: `all:${folder.id}`,
          folder_id: folder.id,
          created_at: EPOCH,
          groups: [own.map(toCondition)],
        }),
      );
    } else {
      // "any": each condition is its own rule, so each gets its own ladder
      // level instead of the folder inheriting the loosest one.
      for (const f of own) {
        rules.push(
          withLevel({
            id: f.id,
            folder_id: folder.id,
            created_at: EPOCH,
            groups: [[toCondition(f)]],
          }),
        );
      }
    }
  }

  return rules;
}

function toCondition(f: Filter): Condition {
  return { field: f.field, op: f.op, value: f.value };
}

function withLevel(rule: Rule): Rule {
  return { ...rule, specificity_level: deriveRuleLevel(rule) };
}

/** Folder-scoped exclusions become stage-1 guardrails. */
export function toGuardrails(filters: Filter[]): Guardrail[] {
  return filters
    .filter((f) => EXCLUDE_OPS.has(f.op))
    .map((f) => ({
      id: f.id,
      scope: "folder" as const,
      kind: "exclusion" as const,
      folder_id: f.folder_id,
      condition: toCondition(f),
    }));
}

/** Always-inbox overrides become inbox pins. */
export function toPins(overrides: Array<{ id: string; match_type: string; value: string }>): Pin[] {
  return overrides.map((o) => ({
    id: o.id,
    kind: "inbox" as const,
    match: o.match_type === "email" ? ("email" as const) : ("domain" as const),
    value: o.value,
  }));
}
