// Pure rule-matching for contact_group_rules. No I/O — takes a contact
// snapshot + rule set and returns which groups the contact should join
// (auto_apply=true) or be suggested to (auto_apply=false).
//
// Used by:
//  - crud.functions.ts on contact insert/update (evaluate + apply)
//  - suggest-groups-for-contact.functions.ts (evaluate + return preview)
//  - applyGroupRulesToAllContacts backfill

export type GroupRule = {
  id: string;
  group_id: string;
  rule_type: "domain" | "company_id" | "ai_category";
  value: string;
  auto_apply: boolean;
};

export type ContactSignals = {
  companyId: string | null;
  aiCategory: string | null;
  /** Every email domain associated with the contact (primary + secondary). Lowercase. */
  emailDomains: string[];
};

export type RuleMatch = {
  ruleId: string;
  groupId: string;
  ruleType: GroupRule["rule_type"];
  value: string;
  autoApply: boolean;
  /** Short human-readable reason for the UI ("nissanusa.com"). */
  reason: string;
};

/** Extract lowercase domain from an email, or null. */
export function domainOfEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

export function collectEmailDomains(
  emails: Array<{ address: string | null | undefined }>,
): string[] {
  const set = new Set<string>();
  for (const e of emails) {
    const d = domainOfEmail(e.address ?? null);
    if (d) set.add(d);
  }
  return [...set];
}

/** Match a contact's signals against a rule set. */
export function matchRules(
  signals: ContactSignals,
  rules: GroupRule[],
): RuleMatch[] {
  const out: RuleMatch[] = [];
  const domSet = new Set(signals.emailDomains.map((d) => d.toLowerCase()));
  const cat = signals.aiCategory?.trim().toLowerCase() ?? null;
  const cid = signals.companyId;
  for (const r of rules) {
    const value = r.value.trim();
    if (!value) continue;
    let hit = false;
    let reason = "";
    if (r.rule_type === "domain") {
      const v = value.toLowerCase().replace(/^@/, "");
      if (domSet.has(v)) {
        hit = true;
        reason = v;
      }
    } else if (r.rule_type === "company_id") {
      if (cid && cid === value) {
        hit = true;
        reason = "linked company";
      }
    } else if (r.rule_type === "ai_category") {
      if (cat && cat === value.toLowerCase()) {
        hit = true;
        reason = value;
      }
    }
    if (hit) {
      out.push({
        ruleId: r.id,
        groupId: r.group_id,
        ruleType: r.rule_type,
        value,
        autoApply: r.auto_apply,
        reason,
      });
    }
  }
  return out;
}

/** Fixed AI-category vocabulary shared by enrichment + rule UI. */
export const AI_CATEGORIES = [
  "software",
  "automotive",
  "finance",
  "legal",
  "media",
  "healthcare",
  "retail",
  "manufacturing",
  "consulting",
  "real_estate",
  "education",
  "nonprofit",
  "government",
  "hospitality",
  "energy",
  "other",
] as const;
export type AiCategory = (typeof AI_CATEGORIES)[number];

export function isAiCategory(v: string): v is AiCategory {
  return (AI_CATEGORIES as readonly string[]).includes(v);
}
