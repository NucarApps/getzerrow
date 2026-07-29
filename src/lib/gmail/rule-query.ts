// Translating a simple folder rule (field/op/value) into a PostgREST
// predicate, shared by the count / apply-to-past server functions so the
// live count in "Filter messages like this" and the actual backfill can
// never disagree about what a rule matches.
import { escapeLike } from "../escape-like";

/** Fields the simple rule builder (FilterLikeThisDrawer) can target. */
export const SIMPLE_RULE_FIELDS = [
  "from",
  "domain",
  "subject",
  "origin_from",
  "origin_domain",
] as const;
export type SimpleRuleField = (typeof SIMPLE_RULE_FIELDS)[number];
export type SimpleRuleOp = "contains" | "equals" | "starts_with";

/** Origin fields fall back to from_addr, mirroring the filter engine. */
export function isOriginField(field: SimpleRuleField): boolean {
  return field === "origin_from" || field === "origin_domain";
}

/** Normalize a rule value the same way addFolderRule stores it. */
export function normalizeRuleValue(field: SimpleRuleField, raw: string): string {
  const v = raw.trim();
  if (field === "subject") return v;
  return v.toLowerCase().replace(/^@/, "");
}

type Ilikeable = {
  ilike(column: string, pattern: string): Ilikeable;
  or(filter: string): Ilikeable;
};

/**
 * Apply a rule's predicate to an `emails` query.
 *
 * `origin_*` fields match the stored origin address, OR fall back to
 * `from_addr` when the row has no origin (direct mail, and every row
 * written before origin tracking existed).
 */
export function applySimpleRulePredicate<T extends Ilikeable>(
  qb: T,
  field: SimpleRuleField,
  op: SimpleRuleOp,
  value: string,
): T {
  const esc = escapeLike(value);
  const senderPattern = op === "starts_with" ? `${esc}%` : op === "equals" ? esc : `%${esc}%`;

  if (field === "subject") {
    const pat = op === "equals" ? esc : op === "starts_with" ? `${esc}%` : `%${esc}%`;
    return qb.ilike("subject", pat) as T;
  }
  if (field === "domain") return qb.ilike("from_addr", `%@${esc}%`) as T;
  if (field === "from") {
    const pat = op === "starts_with" ? `${esc}%` : `%${esc}%`;
    return qb.ilike("from_addr", pat) as T;
  }

  // origin_from / origin_domain — PostgREST `or` values can't carry the
  // reserved characters below, so a value containing them is matched on the
  // origin column alone rather than silently producing a broken filter.
  const pattern = field === "origin_domain" ? `%@${esc}%` : senderPattern;
  if (/[(),]/.test(pattern)) return qb.ilike("origin_addr", pattern) as T;
  return qb.or(
    `origin_addr.ilike.${pattern},and(origin_addr.is.null,from_addr.ilike.${pattern})`,
  ) as T;
}
