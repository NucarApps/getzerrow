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
  .inputValidator((input: unknown) =>
    z
      .object({ primaryDomain: domainSchema, aliasDomain: domainSchema })
      .refine((v) => v.primaryDomain !== v.aliasDomain, {
        message: "Alias must differ from primary",
        path: ["aliasDomain"],
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<CompanyAlias[]> => {
    const { supabase, userId } = context;
    const { primaryDomain, aliasDomain } = data;

    // Cascading merge: if the new alias is itself a primary for other rows,
    // re-point those rows to the new primary.
    const { error: repointErr } = await supabase
      .from("company_aliases")
      .update({ primary_domain: primaryDomain })
      .eq("user_id", userId)
      .eq("primary_domain", aliasDomain);
    if (repointErr) throw new Error(repointErr.message);

    // If primaryDomain was previously aliased somewhere else, drop that row so
    // primaryDomain itself isn't also an alias.
    const { error: cleanupErr } = await supabase
      .from("company_aliases")
      .delete()
      .eq("user_id", userId)
      .eq("alias_domain", primaryDomain);
    if (cleanupErr) throw new Error(cleanupErr.message);

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

export const removeCompanyAlias = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ aliasDomain: domainSchema }).parse(input),
  )
  .handler(async ({ data, context }): Promise<CompanyAlias[]> => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("company_aliases")
      .delete()
      .eq("user_id", userId)
      .eq("alias_domain", data.aliasDomain);
    if (error) throw new Error(error.message);

    const { data: rows, error: listErr } = await supabase
      .from("company_aliases")
      .select("primary_domain, alias_domain")
      .eq("user_id", userId);
    if (listErr) throw new Error(listErr.message);
    return (rows ?? []) as CompanyAlias[];
  });

export const clearCompanyAliases = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ primaryDomain: domainSchema }).parse(input),
  )
  .handler(async ({ data, context }): Promise<CompanyAlias[]> => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("company_aliases")
      .delete()
      .eq("user_id", userId)
      .eq("primary_domain", data.primaryDomain);
    if (error) throw new Error(error.message);

    const { data: rows, error: listErr } = await supabase
      .from("company_aliases")
      .select("primary_domain, alias_domain")
      .eq("user_id", userId);
    if (listErr) throw new Error(listErr.message);
    return (rows ?? []) as CompanyAlias[];
  });
