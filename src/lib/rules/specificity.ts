// The specificity ladder (Amendment 2).
//
// There is no manual rule or folder ordering for filing. When several
// rules match a message, the most specific rule wins:
//
//   L1 exact sender    billing@netflix.com
//   L2 exact domain    @amazon.com — that domain only
//   L3 domain family   amazon.com including subdomains
//   L4 structural      List-Id, to/cc, has-attachment, is-reply
//   L5 content         subject / body contains, patterns
//
// A rule's level is its MOST SPECIFIC condition. Deriving it is pure and
// cheap, so the cached `specificity_level` column is an optimisation, not
// a source of truth: `ruleLevel` prefers the cached value only when it
// agrees with the derivation being possible at all.
import type { Condition, Rule, SpecificityLevel } from "./types";

const SENDER_FIELDS = new Set(["from", "origin_from", "reply_to"]);
const DOMAIN_FIELDS = new Set(["domain", "origin_domain"]);
const STRUCTURAL_FIELDS = new Set(["to", "cc", "list_id", "has_attachment", "is_reply"]);

/** Exact-domain ops: the value names one domain and nothing below it. */
const EXACT_DOMAIN_OPS = new Set(["equals", "domain_in"]);

export function conditionLevel(c: Condition): SpecificityLevel {
  const value = (c.value || "").trim().toLowerCase();

  if (SENDER_FIELDS.has(c.field)) {
    // A sender condition naming a full address is L1. A sender condition
    // holding only a domain fragment ("@amazon.com" / "amazon.com") is
    // really a domain rule and must not outrank one.
    if (value.startsWith("@")) return EXACT_DOMAIN_OPS.has(c.op) ? 2 : 3;
    if (value.includes("@")) return 1;
    return 3;
  }

  if (DOMAIN_FIELDS.has(c.field)) {
    return EXACT_DOMAIN_OPS.has(c.op) ? 2 : 3;
  }

  if (c.field === "sender_in_group") return 4;
  if (STRUCTURAL_FIELDS.has(c.field)) return 4;

  return 5;
}

/** The level of a whole rule: its most specific condition, across every
 * OR group. Rules with no conditions cannot match and sort last. */
export function deriveRuleLevel(rule: Rule): SpecificityLevel {
  let best: SpecificityLevel = 5;
  let seen = false;
  for (const group of rule.groups) {
    for (const c of group) {
      const lvl = conditionLevel(c);
      if (!seen || lvl < best) best = lvl;
      seen = true;
    }
  }
  return best;
}

export function ruleLevel(rule: Rule): SpecificityLevel {
  return rule.specificity_level ?? deriveRuleLevel(rule);
}

/** Total condition count — the first tiebreak inside a level (more
 * conditions = narrower rule = wins). */
export function ruleConditionCount(rule: Rule): number {
  return rule.groups.reduce((n, g) => n + g.length, 0);
}

export const LEVEL_LABELS: Record<SpecificityLevel, string> = {
  1: "L1 exact sender",
  2: "L2 exact domain",
  3: "L3 domain family",
  4: "L4 structural",
  5: "L5 content",
};

export function levelLabel(level: SpecificityLevel): string {
  return LEVEL_LABELS[level];
}
