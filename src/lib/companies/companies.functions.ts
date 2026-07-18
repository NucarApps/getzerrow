import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { normalizeCompanyName } from "./normalize";
import { isPersonalDomain, extractDomain } from "@/lib/company-domains";

type Ctx = { supabase: import("@supabase/supabase-js").SupabaseClient; userId: string };

const nonEmpty = (max: number) => z.string().trim().min(1).max(max);

async function findOrCreateCompanyByName(
  ctx: Ctx,
  rawName: string,
): Promise<{ id: string; name: string } | null> {
  const name = rawName.trim();
  if (!name) return null;
  const key = normalizeCompanyName(name);
  if (!key) return null;
  const { data: existing, error: selErr } = await ctx.supabase
    .from("companies")
    .select("id,name")
    .eq("user_id", ctx.userId)
    .eq("name_key", key)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);
  if (existing) return existing;
  const { data: inserted, error: insErr } = await ctx.supabase
    .from("companies")
    .insert({ user_id: ctx.userId, name, name_key: key })
    .select("id,name")
    .single();
  if (insErr) {
    // Race with a parallel insert — fall back to a re-select.
    const { data: retry } = await ctx.supabase
      .from("companies")
      .select("id,name")
      .eq("user_id", ctx.userId)
      .eq("name_key", key)
      .maybeSingle();
    if (retry) return retry;
    throw new Error(insErr.message);
  }
  return inserted;
}

export async function resolveContactCompany(
  ctx: Ctx,
  companyText: string | null | undefined,
): Promise<{ companyId: string | null; canonicalName: string | null }> {
  if (companyText === null) return { companyId: null, canonicalName: null };
  if (companyText === undefined) return { companyId: null, canonicalName: null };
  const trimmed = companyText.trim();
  if (!trimmed) return { companyId: null, canonicalName: null };
  const found = await findOrCreateCompanyByName(ctx, trimmed);
  if (!found) return { companyId: null, canonicalName: null };
  return { companyId: found.id, canonicalName: found.name };
}

export const listCompanies = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: companies, error } = await supabase
      .from("companies")
      .select("id,name,website,industry")
      .eq("user_id", userId)
      .order("name", { ascending: true })
      .limit(2000);
    if (error) throw new Error(error.message);
    const ids = (companies ?? []).map((c) => c.id);
    if (ids.length === 0) return { companies: [] };
    const [{ data: doms }, { data: mems }] = await Promise.all([
      supabase
        .from("company_domains")
        .select("company_id,domain,source")
        .in("company_id", ids),
      supabase.from("contacts").select("company_id").in("company_id", ids),
    ]);
    const domainMap = new Map<string, { domain: string; source: string }[]>();
    for (const d of doms ?? []) {
      const arr = domainMap.get(d.company_id) ?? [];
      arr.push({ domain: d.domain, source: d.source });
      domainMap.set(d.company_id, arr);
    }
    const memberMap = new Map<string, number>();
    for (const m of mems ?? []) {
      if (!m.company_id) continue;
      memberMap.set(m.company_id, (memberMap.get(m.company_id) ?? 0) + 1);
    }
    return {
      companies: (companies ?? []).map((c) => ({
        ...c,
        domains: domainMap.get(c.id) ?? [],
        member_count: memberMap.get(c.id) ?? 0,
      })),
    };
  });

export const getCompany = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: company, error } = await supabase
      .from("companies")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!company) throw new Error("Company not found");
    const [{ data: domains }, { data: tags }, { data: members }] = await Promise.all([
      supabase
        .from("company_domains")
        .select("id,domain,source,created_at")
        .eq("company_id", data.id)
        .order("source", { ascending: true })
        .order("domain", { ascending: true }),
      supabase
        .from("company_tags")
        .select("id,tag")
        .eq("company_id", data.id)
        .order("tag", { ascending: true }),
      supabase
        .from("contacts")
        .select("id,name,email,title,avatar_url")
        .eq("company_id", data.id)
        .order("name", { ascending: true })
        .limit(500),
    ]);
    return {
      company,
      domains: domains ?? [],
      tags: tags ?? [],
      members: members ?? [],
    };
  });

export const createCompany = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ name: nonEmpty(200) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const c = await findOrCreateCompanyByName(context, data.name);
    if (!c) throw new Error("Invalid company name");
    return { id: c.id, name: c.name };
  });

export const updateCompany = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(200).optional(),
        website: z.string().trim().max(500).nullable().optional(),
        phone: z.string().trim().max(60).nullable().optional(),
        address_line1: z.string().trim().max(200).nullable().optional(),
        address_line2: z.string().trim().max(200).nullable().optional(),
        city: z.string().trim().max(120).nullable().optional(),
        region: z.string().trim().max(120).nullable().optional(),
        postal_code: z.string().trim().max(40).nullable().optional(),
        country: z.string().trim().max(60).nullable().optional(),
        industry: z.string().trim().max(120).nullable().optional(),
        description: z.string().trim().max(4000).nullable().optional(),
        linked_group_id: z.string().uuid().nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { id, ...patch } = data;
    const update: Record<string, unknown> = { ...patch };
    if (typeof patch.name === "string") {
      const key = normalizeCompanyName(patch.name);
      if (!key) throw new Error("Invalid company name");
      update.name_key = key;
    }
    const { error } = await supabase
      .from("companies")
      .update(update as never)
      .eq("id", id)
      .eq("user_id", userId);
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new Error("Another company already uses that name.");
      }
      throw new Error(error.message);
    }
    // Keep linked contacts' display name in sync when we renamed.
    if (typeof patch.name === "string") {
      await supabase
        .from("contacts")
        .update({ company: patch.name })
        .eq("user_id", userId)
        .eq("company_id", id);
    }
    return { ok: true as const };
  });

export const addCompanyDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ id: z.string().uuid(), domain: z.string().trim().min(1).max(253) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const domain = extractDomain(data.domain) ?? data.domain.trim().toLowerCase();
    if (!domain) throw new Error("Invalid domain");
    const { error } = await supabase
      .from("company_domains")
      .upsert(
        { user_id: userId, company_id: data.id, domain, source: "manual" },
        { onConflict: "user_id,domain" },
      );
    if (error) throw new Error(error.message);
    return { ok: true as const, domain };
  });

export const removeCompanyDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("company_domains")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const setCompanyTags = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        tags: z.array(z.string().trim().min(1).max(40)).max(30),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const uniq = Array.from(new Set(data.tags.map((t) => t.toLowerCase())));
    const { error: delErr } = await supabase
      .from("company_tags")
      .delete()
      .eq("company_id", data.id)
      .eq("user_id", userId);
    if (delErr) throw new Error(delErr.message);
    if (uniq.length > 0) {
      const { error: insErr } = await supabase.from("company_tags").insert(
        uniq.map((tag) => ({ user_id: userId, company_id: data.id, tag })),
      );
      if (insErr) throw new Error(insErr.message);
    }
    return { ok: true as const };
  });

export const mergeCompanies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ sourceId: z.string().uuid(), targetId: z.string().uuid() })
      .refine((v) => v.sourceId !== v.targetId, { message: "Cannot merge a company into itself" })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Reassign contacts.
    const { data: targetRow, error: tErr } = await supabase
      .from("companies")
      .select("id,name")
      .eq("id", data.targetId)
      .eq("user_id", userId)
      .maybeSingle();
    if (tErr) throw new Error(tErr.message);
    if (!targetRow) throw new Error("Target company not found");
    await supabase
      .from("contacts")
      .update({ company_id: data.targetId, company: targetRow.name })
      .eq("user_id", userId)
      .eq("company_id", data.sourceId);
    // Move domains — upsert to avoid unique conflict on (user_id, domain).
    const { data: srcDomains } = await supabase
      .from("company_domains")
      .select("domain,source")
      .eq("company_id", data.sourceId)
      .eq("user_id", userId);
    if (srcDomains && srcDomains.length > 0) {
      await supabase
        .from("company_domains")
        .delete()
        .eq("company_id", data.sourceId)
        .eq("user_id", userId);
      await supabase.from("company_domains").upsert(
        srcDomains.map((d) => ({
          user_id: userId,
          company_id: data.targetId,
          domain: d.domain,
          source: d.source,
        })),
        { onConflict: "user_id,domain" },
      );
    }
    // Move tags.
    const { data: srcTags } = await supabase
      .from("company_tags")
      .select("tag")
      .eq("company_id", data.sourceId)
      .eq("user_id", userId);
    if (srcTags && srcTags.length > 0) {
      await supabase
        .from("company_tags")
        .delete()
        .eq("company_id", data.sourceId)
        .eq("user_id", userId);
      for (const t of srcTags) {
        await supabase
          .from("company_tags")
          .upsert(
            { user_id: userId, company_id: data.targetId, tag: t.tag },
            { onConflict: "company_id,tag" },
          );
      }
    }
    // Delete source.
    await supabase
      .from("companies")
      .delete()
      .eq("id", data.sourceId)
      .eq("user_id", userId);
    return { ok: true as const };
  });

export const deleteCompany = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // company_id on contacts is ON DELETE SET NULL, so contacts are preserved.
    const { error } = await supabase
      .from("companies")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

// Suppress the personal-domain import if unused elsewhere.
void isPersonalDomain;
