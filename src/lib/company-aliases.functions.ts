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

/**
 * Swap the primary and one of its aliases. All other aliases of the old
 * primary repoint to the new primary, and any side-tables keyed on the
 * primary domain (logo choice, group assignments) migrate too.
 */
export const promoteAliasToPrimary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ currentPrimary: domainSchema, newPrimary: domainSchema })
      .refine((v) => v.currentPrimary !== v.newPrimary, {
        message: "Domains must differ",
        path: ["newPrimary"],
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<CompanyAlias[]> => {
    const { supabase, userId } = context;
    const { currentPrimary, newPrimary } = data;

    // Verify newPrimary is currently an alias of currentPrimary.
    const { data: existing, error: vErr } = await supabase
      .from("company_aliases")
      .select("primary_domain, alias_domain")
      .eq("user_id", userId)
      .eq("alias_domain", newPrimary)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!existing || existing.primary_domain !== currentPrimary) {
      throw new Error("That domain isn't currently an alias of this company");
    }

    // Repoint every alias of currentPrimary to newPrimary.
    const { error: rpErr } = await supabase
      .from("company_aliases")
      .update({ primary_domain: newPrimary })
      .eq("user_id", userId)
      .eq("primary_domain", currentPrimary);
    if (rpErr) throw new Error(rpErr.message);

    // Drop the row where alias_domain == newPrimary (it's now the primary).
    const { error: dropErr } = await supabase
      .from("company_aliases")
      .delete()
      .eq("user_id", userId)
      .eq("alias_domain", newPrimary);
    if (dropErr) throw new Error(dropErr.message);

    // Make the old primary an alias of the new primary.
    const { error: insErr } = await supabase
      .from("company_aliases")
      .upsert(
        { user_id: userId, primary_domain: newPrimary, alias_domain: currentPrimary },
        { onConflict: "user_id,alias_domain" },
      );
    if (insErr) throw new Error(insErr.message);

    // Migrate company_logo_choices keyed on currentPrimary -> newPrimary.
    // Drop any conflicting row for newPrimary first.
    await supabase
      .from("company_logo_choices")
      .delete()
      .eq("user_id", userId)
      .eq("domain", newPrimary);
    await supabase
      .from("company_logo_choices")
      .update({ domain: newPrimary })
      .eq("user_id", userId)
      .eq("domain", currentPrimary);

    // Migrate company_group_assignments keyed on currentPrimary -> newPrimary.
    const { data: oldAssignments } = await supabase
      .from("company_group_assignments")
      .select("group_id")
      .eq("user_id", userId)
      .eq("primary_domain", currentPrimary);
    if (oldAssignments && oldAssignments.length > 0) {
      await supabase
        .from("company_group_assignments")
        .delete()
        .eq("user_id", userId)
        .eq("primary_domain", currentPrimary);
      const rows = oldAssignments.map((r) => ({
        user_id: userId,
        primary_domain: newPrimary,
        group_id: r.group_id,
      }));
      await supabase
        .from("company_group_assignments")
        .upsert(rows, { onConflict: "user_id,primary_domain,group_id", ignoreDuplicates: true });
    }

    const { data: rows, error: listErr } = await supabase
      .from("company_aliases")
      .select("primary_domain, alias_domain")
      .eq("user_id", userId);
    if (listErr) throw new Error(listErr.message);
    return (rows ?? []) as CompanyAlias[];
  });

