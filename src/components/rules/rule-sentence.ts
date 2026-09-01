// Presentation helpers for the sentence-style rule editor (Phase D).
//
// A rule reads as a sentence: "File mail where the sender contains
// billing@netflix.com into Receipts". These helpers turn conditions into
// that sentence and parse what the user types into a condition, so the
// editor holds layout only.
import { conditionLevel, deriveRuleLevel, levelLabel } from "@/lib/rules/specificity";
import type { Condition, Rule, SpecificityLevel } from "@/lib/rules/types";

export type FieldOption = {
  value: string;
  /** How the field reads inside the sentence. */
  label: string;
  /** Fields whose value is a fixed yes/no rather than free text. */
  boolean?: boolean;
};

export const FIELD_OPTIONS: FieldOption[] = [
  { value: "from", label: "the sender" },
  { value: "origin_from", label: "the original sender (before forwarding)" },
  { value: "domain", label: "the sender's domain" },
  { value: "origin_domain", label: "the original domain (before forwarding)" },
  { value: "reply_to", label: "the reply-to address" },
  { value: "to", label: "the To line" },
  { value: "cc", label: "the Cc line" },
  { value: "subject", label: "the subject" },
  { value: "body", label: "the body" },
  { value: "list_id", label: "the mailing list id" },
  { value: "is_reply", label: "the message is a reply", boolean: true },
  { value: "has_attachment", label: "the message has an attachment", boolean: true },
];

export const OP_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "contains", label: "contains" },
  { value: "equals", label: "is exactly" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "domain_in", label: "is one of" },
  { value: "not_contains", label: "does not contain" },
  { value: "not_equals", label: "is not" },
  { value: "regex", label: "matches the pattern" },
];

export const fieldLabel = (field: string): string =>
  FIELD_OPTIONS.find((f) => f.value === field)?.label ?? field;

export const opLabel = (op: string): string => OP_OPTIONS.find((o) => o.value === op)?.label ?? op;

export const isBooleanField = (field: string): boolean =>
  FIELD_OPTIONS.find((f) => f.value === field)?.boolean === true;

/** The sentence for one condition, without the leading "where". */
export function conditionSentence(c: Condition): string {
  if (isBooleanField(c.field)) {
    const yes = (c.value || "").toLowerCase() !== "false";
    return `${fieldLabel(c.field)} is ${yes ? "yes" : "no"}`;
  }
  return `${fieldLabel(c.field)} ${opLabel(c.op)} "${c.value}"`;
}

/** Best-guess condition from free text, so typing an address or a domain
 * produces the right field and operator without touching the dropdowns. */
export function parseConditionInput(raw: string): Condition {
  const value = raw.trim();
  if (/^@?[\w.-]+\.\w{2,}$/i.test(value) && !value.includes("@", 1)) {
    // "@acme.com" or "acme.com" — an exact-domain rule (L2).
    return { field: "domain", op: "equals", value: value.replace(/^@/, "").toLowerCase() };
  }
  if (/^[^\s@]+@[^\s@]+\.\w{2,}$/.test(value)) {
    return { field: "from", op: "contains", value: value.toLowerCase() };
  }
  return { field: "subject", op: "contains", value };
}

/** Ladder level of a draft, for the badge next to the sentence. */
export function draftLevel(groups: Condition[][]): SpecificityLevel {
  const rule: Rule = { id: "draft", folder_id: "", created_at: "", groups };
  return deriveRuleLevel(rule);
}

export { conditionLevel, levelLabel };
