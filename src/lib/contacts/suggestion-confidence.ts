// Deterministic auto-apply gate for background group suggestions.
//
// Contract: the AI's self-reported confidence is a VETO, never a
// justification — a suggestion only auto-applies when hard evidence backs
// it: the members overwhelmingly share one company (and the target is that
// company's label), or they all share one non-personal domain mapping to
// one company. Everything else stays pending in the suggestions drawer.

export type GateSuggestion = {
  contact_ids: string[];
  confidence: "high" | "medium" | "low" | null;
};

export type GateContext = {
  /** contacts.company_id per suggested member. */
  companyIdByContact: Map<string, string | null>;
  /** Lowercased email domain per suggested member. */
  domainByContact: Map<string, string | null>;
  isPersonalDomain: (domain: string) => boolean;
  /** company_domains: domain → company_id. */
  companyIdByDomain: Map<string, string>;
  /** The company whose label the suggestion targets (via linked_group_id or
   * an existing company_id rule on the target group), when known. */
  targetLabelCompanyId: string | null;
  /** The company the suggestion NAME resolves to (alias-aware), when any. */
  suggestionNameCompanyId: string | null;
};

export type GateResult = {
  autoApply: boolean;
  reason: string;
  /** Durable rule to create when auto-applying, so the grouping keeps
   * itself current instead of being a one-shot member copy. */
  rule: { ruleType: "company_id" | "domain"; value: string } | null;
  evidence: Record<string, unknown>;
};

const COMPANY_SHARE_THRESHOLD = 0.8;

export function evaluateAutoApply(suggestion: GateSuggestion, ctx: GateContext): GateResult {
  const members = [...new Set(suggestion.contact_ids)];
  const no = (reason: string, evidence: Record<string, unknown> = {}): GateResult => ({
    autoApply: false,
    reason,
    rule: null,
    evidence,
  });

  if (suggestion.confidence !== "high") return no("ai_confidence_not_high");
  if (members.length < 2) return no("too_few_members");

  // Company-backed: ≥80% (and ≥2) of members share one company_id, and the
  // suggestion demonstrably IS that company (its label or its name).
  const companyCounts = new Map<string, number>();
  for (const id of members) {
    const companyId = ctx.companyIdByContact.get(id);
    if (companyId) companyCounts.set(companyId, (companyCounts.get(companyId) ?? 0) + 1);
  }
  let dominant: string | null = null;
  let dominantCount = 0;
  for (const [companyId, count] of companyCounts) {
    if (count > dominantCount) {
      dominant = companyId;
      dominantCount = count;
    }
  }
  if (dominant && dominantCount >= 2 && dominantCount / members.length >= COMPANY_SHARE_THRESHOLD) {
    if (ctx.targetLabelCompanyId && ctx.targetLabelCompanyId !== dominant) {
      return no("target_label_different_company", { dominant_company: dominant });
    }
    if (ctx.targetLabelCompanyId === dominant || ctx.suggestionNameCompanyId === dominant) {
      return {
        autoApply: true,
        reason: "company_backed",
        rule: { ruleType: "company_id", value: dominant },
        evidence: {
          dominant_company: dominant,
          share: dominantCount / members.length,
          members: members.length,
        },
      };
    }
    return no("company_cluster_without_label_link", { dominant_company: dominant });
  }
  if (ctx.targetLabelCompanyId && dominant && ctx.targetLabelCompanyId !== dominant) {
    return no("target_label_different_company", { dominant_company: dominant });
  }

  // Domain-backed: every member shares one non-personal domain that maps to
  // exactly one known company.
  const domains = new Set<string>();
  for (const id of members) {
    const domain = ctx.domainByContact.get(id);
    if (!domain) return no("member_without_domain");
    domains.add(domain.toLowerCase());
  }
  if (domains.size === 1) {
    const [domain] = [...domains];
    if (ctx.isPersonalDomain(domain)) return no("personal_domain", { domain });
    const companyId = ctx.companyIdByDomain.get(domain);
    if (!companyId) return no("domain_without_company", { domain });
    if (ctx.targetLabelCompanyId && ctx.targetLabelCompanyId !== companyId) {
      return no("target_label_different_company", { domain, company: companyId });
    }
    return {
      autoApply: true,
      reason: "domain_backed",
      rule: { ruleType: "domain", value: domain },
      evidence: { domain, company: companyId, members: members.length },
    };
  }

  return no("no_deterministic_evidence", {
    distinct_domains: domains.size,
    dominant_company: dominant,
  });
}
