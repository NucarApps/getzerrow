// Server-side loader for the CompanyKeyContext consumed by the pure
// deriveCompanyKey (company-key.ts). Kept out of company-key.ts so that
// module stays free of Supabase imports and unit-testable.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { CompanyKeyContext } from "./company-key";

/**
 * Load the four lookup maps deriveCompanyKey needs — domain aliases, every
 * company name, merged-name aliases (name_key → canonical name), and
 * domain→company links — so all key derivations resolve fragmented/merged
 * company variants to one canonical bucket. Every query is user-scoped.
 */
export async function loadCompanyKeyContext(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<CompanyKeyContext> {
  const [
    { data: aliasRows },
    { data: allCompanyRows },
    { data: nameAliasRows },
    { data: companyDomainRows },
  ] = await Promise.all([
    supabase.from("company_aliases").select("primary_domain, alias_domain").eq("user_id", userId),
    supabase.from("companies").select("id,name").eq("user_id", userId),
    supabase.from("company_name_aliases").select("name_key,company_id").eq("user_id", userId),
    supabase.from("company_domains").select("domain,company_id").eq("user_id", userId),
  ]);

  const domainAliases = new Map<string, string>();
  for (const r of aliasRows ?? []) {
    if (r.alias_domain && r.primary_domain) domainAliases.set(r.alias_domain, r.primary_domain);
  }
  const companiesById = new Map<string, string>();
  for (const c of allCompanyRows ?? []) {
    if (c.id && c.name) companiesById.set(c.id, c.name);
  }
  const nameAliases = new Map<string, string>();
  for (const r of (nameAliasRows ?? []) as Array<{
    name_key: string;
    company_id: string | null;
  }>) {
    const canonical = r.company_id ? companiesById.get(r.company_id) : null;
    if (r.name_key && canonical) nameAliases.set(r.name_key, canonical);
  }
  const companyIdByDomain = new Map<string, string>();
  for (const r of (companyDomainRows ?? []) as Array<{
    domain: string;
    company_id: string;
  }>) {
    if (r.domain && r.company_id) companyIdByDomain.set(r.domain, r.company_id);
  }

  return { domainAliases, companiesById, nameAliases, companyIdByDomain };
}
