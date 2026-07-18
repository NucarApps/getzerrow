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
  // 1. Direct name_key match on companies.
  const { data: existing, error: selErr } = await ctx.supabase
    .from("companies")
    .select("id,name")
    .eq("user_id", ctx.userId)
    .eq("name_key", key)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);
  if (existing) return existing;
  // 2. Alias match: an earlier merge remembered this name pointing at
  //    the canonical company. Route the new reference to the target
  //    instead of recreating the duplicate.
  const { data: alias } = await ctx.supabase
    .from("company_name_aliases")
    .select("company_id, companies:companies(id,name)")
    .eq("user_id", ctx.userId)
    .eq("name_key", key)
    .maybeSingle();
  const aliased = (alias as { companies?: { id: string; name: string } | null } | null)?.companies;
  if (aliased) return aliased;
  // 3. Insert.
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
        .select("company_id,domain,source,member_count,discovered_from_contact_id")
        .in("company_id", ids)
        .order("source", { ascending: false }) // manual > auto
        .order("member_count", { ascending: false })
        .order("created_at", { ascending: true }),
      supabase.from("contacts").select("company_id").in("company_id", ids),
    ]);
    type DomainRow = {
      domain: string;
      source: string;
      member_count: number;
      discovered_from_contact_id: string | null;
    };
    const domainMap = new Map<string, DomainRow[]>();
    for (const d of doms ?? []) {
      const arr = domainMap.get(d.company_id) ?? [];
      arr.push({
        domain: d.domain,
        source: d.source,
        member_count: d.member_count,
        discovered_from_contact_id: d.discovered_from_contact_id,
      });
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
        .select("id,domain,source,member_count,discovered_from_contact_id,created_at")
        .eq("company_id", data.id)
        // Manual pins beat auto; then most-shared; then oldest.
        .order("source", { ascending: false })
        .order("member_count", { ascending: false })
        .order("created_at", { ascending: true }),
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
    // Resolve introducer display name for each auto domain.
    const introducerIds = Array.from(
      new Set(
        (domains ?? [])
          .map((d) => d.discovered_from_contact_id)
          .filter((v): v is string => !!v),
      ),
    );
    const introducerMap = new Map<string, { name: string | null; email: string | null }>();
    if (introducerIds.length > 0) {
      const { data: intros } = await supabase
        .from("contacts")
        .select("id,name,email")
        .in("id", introducerIds);
      for (const c of intros ?? []) {
        introducerMap.set(c.id, { name: c.name, email: c.email });
      }
    }
    return {
      company,
      domains: (domains ?? []).map((d) => ({
        ...d,
        discovered_from: d.discovered_from_contact_id
          ? (introducerMap.get(d.discovered_from_contact_id) ?? null)
          : null,
      })),
      tags: tags ?? [],
      members: members ?? [],
    };
  });

export const discoverCompanyDomains = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: rows, error } = await supabase.rpc("discover_company_domains", {
      p_company_id: data.id,
      p_user_id: userId,
    });
    if (error) throw new Error(error.message);
    const row = (rows as { added: number; updated: number; total_auto: number }[] | null)?.[0];
    return {
      added: row?.added ?? 0,
      updated: row?.updated ?? 0,
      total: row?.total_auto ?? 0,
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
    // Keep linked contacts' display name in sync when we renamed, then
    // recompute any auto-company subgroup labels so the group name follows
    // the new company name (e.g. "Volkswagen of North America" → "Volkswagen").
    if (typeof patch.name === "string") {
      const { data: updated } = await supabase
        .from("contacts")
        .update({ company: patch.name })
        .eq("user_id", userId)
        .eq("company_id", id)
        .select("id");
      const ids = (updated ?? []).map((r) => (r as { id: string }).id);
      if (ids.length > 0) {
        const { reconcileAutoParentsForContacts } = await import(
          "@/lib/contacts/auto-company-subgroups.functions"
        );
        await reconcileAutoParentsForContacts(supabase, userId, ids);
      }
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

export const previewMergeCompanies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ sourceId: z.string().uuid(), targetId: z.string().uuid() })
      .refine((v) => v.sourceId !== v.targetId, {
        message: "Cannot merge a company into itself",
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const [srcCo, tgtCo] = await Promise.all([
      supabase
        .from("companies")
        .select("id,name")
        .eq("id", data.sourceId)
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .from("companies")
        .select("id,name")
        .eq("id", data.targetId)
        .eq("user_id", userId)
        .maybeSingle(),
    ]);
    if (srcCo.error) throw new Error(srcCo.error.message);
    if (tgtCo.error) throw new Error(tgtCo.error.message);
    if (!srcCo.data) throw new Error("Source company not found");
    if (!tgtCo.data) throw new Error("Target company not found");

    const [contacts, srcDomains, tgtDomains, srcTags, tgtTags] = await Promise.all([
      supabase
        .from("contacts")
        .select("id,name,email")
        .eq("user_id", userId)
        .eq("company_id", data.sourceId)
        .order("name", { ascending: true })
        .limit(500),
      supabase
        .from("company_domains")
        .select("domain,source")
        .eq("user_id", userId)
        .eq("company_id", data.sourceId),
      supabase
        .from("company_domains")
        .select("domain")
        .eq("user_id", userId)
        .eq("company_id", data.targetId),
      supabase
        .from("company_tags")
        .select("tag")
        .eq("user_id", userId)
        .eq("company_id", data.sourceId),
      supabase
        .from("company_tags")
        .select("tag")
        .eq("user_id", userId)
        .eq("company_id", data.targetId),
    ]);

    const tgtDomainSet = new Set((tgtDomains.data ?? []).map((d) => d.domain));
    const tgtTagSet = new Set((tgtTags.data ?? []).map((t) => t.tag));

    const domains = (srcDomains.data ?? []).map((d) => ({
      domain: d.domain,
      source: d.source,
      // The upsert on (user_id, domain) collapses duplicates onto the target,
      // so surface that in the preview instead of pretending it will be added.
      conflict: tgtDomainSet.has(d.domain),
    }));
    const tags = (srcTags.data ?? []).map((t) => ({
      tag: t.tag,
      conflict: tgtTagSet.has(t.tag),
    }));

    return {
      source: srcCo.data,
      target: tgtCo.data,
      contacts: contacts.data ?? [],
      contactCount: contacts.data?.length ?? 0,
      domains,
      tags,
    };
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
    const { data: movedContacts, error: moveErr } = await supabase
      .from("contacts")
      .update({ company_id: data.targetId, company: targetRow.name })
      .eq("user_id", userId)
      .eq("company_id", data.sourceId)
      .select("id");
    if (moveErr) throw new Error(moveErr.message);
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
    // Move remembered company-logo hashes so legacy logo snapshots remain
    // detectable after duplicate companies are consolidated.
    const { data: srcHashes } = await supabase
      .from("company_logo_hashes")
      .select("domain,sha256,source")
      .eq("company_id", data.sourceId)
      .eq("user_id", userId);
    if (srcHashes && srcHashes.length > 0) {
      await supabase
        .from("company_logo_hashes")
        .delete()
        .eq("company_id", data.sourceId)
        .eq("user_id", userId);
      await supabase.from("company_logo_hashes").upsert(
        srcHashes.map((h) => ({
          user_id: userId,
          company_id: data.targetId,
          domain: h.domain,
          sha256: h.sha256,
          source: h.source,
          last_seen_at: new Date().toISOString(),
        })),
        { onConflict: "user_id,company_id,sha256" },
      );
    }
    const movedIds = (movedContacts ?? []).map((row) => (row as { id: string }).id);
    // Pull the source company's row so we can remember its name as an
    // alias before deletion.
    const { data: srcCompany } = await supabase
      .from("companies")
      .select("id,name,name_key")
      .eq("id", data.sourceId)
      .eq("user_id", userId)
      .maybeSingle();
    // Backfill: any contact whose free-text `company` matches the source
    // name (or any existing alias of the source) but has no company_id
    // should link to the target.
    if (srcCompany) {
      const { data: srcAliases } = await supabase
        .from("company_name_aliases")
        .select("name_key, source_name")
        .eq("user_id", userId)
        .eq("company_id", data.sourceId);
      const nameKeys = new Set<string>();
      const sourceNames = new Set<string>();
      if (srcCompany.name_key) nameKeys.add(srcCompany.name_key);
      sourceNames.add(srcCompany.name);
      for (const a of srcAliases ?? []) {
        nameKeys.add(a.name_key);
        sourceNames.add(a.source_name);
      }
      // Reassign any contact with company_id NULL but matching name.
      if (sourceNames.size > 0) {
        const { data: strayContacts } = await supabase
          .from("contacts")
          .update({ company_id: data.targetId, company: targetRow.name })
          .eq("user_id", userId)
          .is("company_id", null)
          .in("company", [...sourceNames])
          .select("id");
        for (const r of strayContacts ?? []) {
          movedIds.push((r as { id: string }).id);
        }
      }
      // Remember the alias so future creates/enrichments route here.
      const aliasRows = [
        { user_id: userId, name_key: srcCompany.name_key, company_id: data.targetId, source_name: srcCompany.name },
        ...([...srcAliases ?? []].map((a) => ({
          user_id: userId,
          name_key: a.name_key,
          company_id: data.targetId,
          source_name: a.source_name,
        }))),
      ];
      if (aliasRows.length > 0) {
        await supabase
          .from("company_name_aliases")
          .upsert(aliasRows, { onConflict: "user_id,name_key" });
      }
    }
    if (movedIds.length > 0) {
      const { reconcileAutoParentsForContacts } = await import(
        "@/lib/contacts/auto-company-subgroups.functions"
      );
      await reconcileAutoParentsForContacts(supabase, userId, movedIds);
    }
    // Delete source.
    await supabase
      .from("companies")
      .delete()
      .eq("id", data.sourceId)
      .eq("user_id", userId);
    return { ok: true as const, movedContacts: movedIds.length };
  });


export const deleteCompany = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Capture affected contacts BEFORE the delete so we can prune their
    // auto-company subgroup labels after the FK goes NULL. Otherwise the
    // previous company's subgroup label lingers as a duplicate.
    const { data: affected } = await supabase
      .from("contacts")
      .select("id")
      .eq("user_id", userId)
      .eq("company_id", data.id);
    // company_id on contacts is ON DELETE SET NULL, so contacts are preserved.
    const { error } = await supabase
      .from("companies")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    const ids = (affected ?? []).map((r) => (r as { id: string }).id);
    if (ids.length > 0) {
      const { reconcileAutoParentsForContacts } = await import(
        "@/lib/contacts/auto-company-subgroups.functions"
      );
      await reconcileAutoParentsForContacts(supabase, userId, ids);
    }
    return { ok: true as const };
  });

// Suppress the personal-domain import if unused elsewhere.
void isPersonalDomain;
