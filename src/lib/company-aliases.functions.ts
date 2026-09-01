import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isPersonalDomain } from "@/lib/company-domains";

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((d) => DOMAIN_RE.test(d), { message: "Invalid domain" })
  .refine((d) => !isPersonalDomain(d), { message: "Personal email domains aren't allowed" });

export type CompanyAlias = { primary_domain: string; alias_domain: string };

export const listCompanyAliases = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CompanyAlias[]> => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("company_aliases")
      .select("primary_domain, alias_domain")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return (data ?? []) as CompanyAlias[];
  });

export const addCompanyAlias = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => {
    const parsed = z
      .object({ primaryDomain: domainSchema, aliasDomain: domainSchema })
      .parse(input);
    if (parsed.primaryDomain === parsed.aliasDomain) {
      throw new Error("Alias domain must differ from the primary domain");
    }
    return parsed;
  })
  .handler(async ({ data, context }): Promise<CompanyAlias[]> => {
    const { supabase, userId } = context;
    const { primaryDomain, aliasDomain } = data;

    // If primaryDomain was previously aliased somewhere else, drop that row so
    // primaryDomain itself isn't also an alias. This must happen BEFORE the
    // cascading repoint below: a reverse row (primary=aliasDomain,
    // alias=primaryDomain) would otherwise be rewritten into
    // (primaryDomain, primaryDomain) and violate the table's
    // primary<>alias CHECK constraint.
    const { error: cleanupErr } = await supabase
      .from("company_aliases")
      .delete()
      .eq("user_id", userId)
      .eq("alias_domain", primaryDomain);
    if (cleanupErr) throw new Error(cleanupErr.message);

    // Cascading merge: if the new alias is itself a primary for other rows,
    // re-point those rows to the new primary.
    const { error: repointErr } = await supabase
      .from("company_aliases")
      .update({ primary_domain: primaryDomain })
      .eq("user_id", userId)
      .eq("primary_domain", aliasDomain);
    if (repointErr) throw new Error(repointErr.message);

    const { error } = await supabase
      .from("company_aliases")
      .upsert(
        { user_id: userId, primary_domain: primaryDomain, alias_domain: aliasDomain },
        { onConflict: "user_id,alias_domain" },
      );
    if (error) throw new Error(error.message);

    const { data: rows, error: listErr } = await supabase
      .from("company_aliases")
      .select("primary_domain, alias_domain")
      .eq("user_id", userId);
    if (listErr) throw new Error(listErr.message);
    return (rows ?? []) as CompanyAlias[];
  });
