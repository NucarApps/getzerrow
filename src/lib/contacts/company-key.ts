/**
 * Pure derivation of a contact's company bucket key — used by the
 * auto-company-subgroups reconciler to decide which subgroup a contact
 * belongs to. Kept free of server-fn imports so it is unit-testable.
 */
import { normalizeCompanyName } from "./company-name";
import { normalizeCompanyName as mildNormalizeCompanyName } from "@/lib/companies/normalize";
import {
  contactLogoDomain,
  isPersonalDomain,
  prettyCompanyName,
  resolveCompanyDomain,
} from "@/lib/company-domains";

export type CompanyKeyContact = {
  company: string | null;
  email: string | null;
  website: string | null;
  company_id: string | null;
};

/** Lookup context for deriving a contact's company bucket. */
export type CompanyKeyContext = {
  /** company_aliases: alias domain → primary domain. */
  domainAliases: Map<string, string> | null;
  /** companies.id → companies.name for the user's companies. */
  companiesById: Map<string, string> | null;
  /** company_name_aliases: mild name_key → canonical company name. */
  nameAliases: Map<string, string> | null;
  /** company_domains: domain → company_id. */
  companyIdByDomain: Map<string, string> | null;
};

export type DerivedCompanyKey = {
  key: string;
  displayName: string;
  rawCompany: string | null;
  fromCompany: boolean;
};

/** Derive a normalized company key + display name from a contact. Prefers
 *  the linked Company entity, then the free-text `company` value, then the
 *  non-personal email/website domain.
 *
 *  All branches key on the aggressively-normalized (and alias-resolved)
 *  company NAME — never the company row id — so contacts linked to
 *  fragmented duplicate rows ("Nissan", "Nissan North America",
 *  "Nissan-USA") land in ONE bucket and produce ONE auto subgroup, while
 *  genuinely distinct businesses that share a brand token ("Nissan Of
 *  Keene") keep their own key. */
export function deriveCompanyKey(
  contact: CompanyKeyContact,
  ctx: CompanyKeyContext,
): DerivedCompanyKey | null {
  // Resolve a merged-away name variant to its canonical company name.
  const canonicalize = (name: string): string => {
    const mild = mildNormalizeCompanyName(name);
    return (mild && ctx.nameAliases?.get(mild)) || name;
  };
  const fromCompanyId = (companyId: string): DerivedCompanyKey | null => {
    const name = ctx.companiesById?.get(companyId);
    if (!name) return null;
    const canonical = canonicalize(name);
    const key =
      normalizeCompanyName(canonical) ?? mildNormalizeCompanyName(canonical) ?? "cid:" + companyId;
    return { key, displayName: canonical, rawCompany: canonical, fromCompany: true };
  };

  if (contact.company_id) {
    const derived = fromCompanyId(contact.company_id);
    if (derived) return derived;
  }
  const rawCompany = (contact.company ?? "").trim() || null;
  if (rawCompany) {
    const canonical = canonicalize(rawCompany);
    const key = normalizeCompanyName(canonical);
    if (key) {
      return {
        key,
        displayName: canonical,
        rawCompany: canonical,
        fromCompany: canonical !== rawCompany,
      };
    }
  }
  const raw = contactLogoDomain(contact.website, contact.email);
  const resolved = resolveCompanyDomain(raw, ctx.domainAliases);
  if (resolved && !isPersonalDomain(resolved)) {
    // A domain that belongs to a known Company collapses into that
    // company's bucket instead of minting a "Nissan-usa.com" one.
    const domainCompanyId = ctx.companyIdByDomain?.get(resolved);
    if (domainCompanyId) {
      const derived = fromCompanyId(domainCompanyId);
      if (derived) return { ...derived, rawCompany: null };
    }
    const pretty = prettyCompanyName(resolved);
    const key = normalizeCompanyName(pretty);
    if (key) return { key, displayName: pretty, rawCompany: null, fromCompany: false };
  }
  return null;
}
