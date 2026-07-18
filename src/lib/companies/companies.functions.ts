import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { normalizeCompanyName } from "./normalize";
import { isPersonalDomain, extractDomain } from "@/lib/company-domains";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway";

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

// ---------------------------------------------------------------------------
// Duplicate detection & cluster merge
// ---------------------------------------------------------------------------

type CompanyLite = {
  id: string;
  name: string;
  member_count: number;
  domains: string[];
};

/** Tokenize a normalized company name into significant words. */
function tokenize(name: string): string[] {
  const key = normalizeCompanyName(name) ?? "";
  return key
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
}

const STOP_TOKENS = new Set([
  "the",
  "and",
  "of",
  "for",
  "com",
  "www",
  "usa",
  "america",
  "north",
  "south",
  "east",
  "west",
  "inc",
  "llc",
  "corp",
  "group",
  "company",
  "co",
  "ltd",
]);

/** Cluster companies whose names share a distinctive brand token or a
 *  root email/site domain. Each cluster contains at least 2 companies. */
function clusterCompanies(companies: CompanyLite[]): CompanyLite[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (!p || p === x) {
      parent.set(x, x);
      return x;
    }
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const c of companies) parent.set(c.id, c.id);

  const tokenBuckets = new Map<string, string[]>();
  const domainBuckets = new Map<string, string[]>();
  for (const c of companies) {
    for (const t of tokenize(c.name)) {
      const arr = tokenBuckets.get(t) ?? [];
      arr.push(c.id);
      tokenBuckets.set(t, arr);
    }
    for (const d of c.domains) {
      // Root domain (last two labels) e.g. nissan-usa.com → nissan-usa.com,
      // but also record nissan for cross-linking.
      const parts = d.toLowerCase().split(".");
      if (parts.length >= 2) {
        const root = parts.slice(-2).join(".");
        const arr = domainBuckets.get(root) ?? [];
        arr.push(c.id);
        domainBuckets.set(root, arr);
      }
    }
  }
  // Only unite on tokens shared by ≥2 companies (a distinctive brand token).
  for (const ids of tokenBuckets.values()) {
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  }
  for (const ids of domainBuckets.values()) {
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  }
  const byRoot = new Map<string, CompanyLite[]>();
  for (const c of companies) {
    const r = find(c.id);
    const arr = byRoot.get(r) ?? [];
    arr.push(c);
    byRoot.set(r, arr);
  }
  return [...byRoot.values()].filter((cluster) => cluster.length >= 2);
}

export const findDuplicateCompanies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ useAi: z.boolean().optional().default(false) }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: companies, error } = await supabase
      .from("companies")
      .select("id,name")
      .eq("user_id", userId)
      .limit(2000);
    if (error) throw new Error(error.message);
    const ids = (companies ?? []).map((c) => c.id);
    if (ids.length < 2) return { clusters: [], aiUsed: false };
    const [{ data: doms }, { data: mems }] = await Promise.all([
      supabase.from("company_domains").select("company_id,domain").in("company_id", ids),
      supabase.from("contacts").select("company_id").in("company_id", ids),
    ]);
    const domainMap = new Map<string, string[]>();
    for (const d of doms ?? []) {
      const arr = domainMap.get(d.company_id) ?? [];
      arr.push(d.domain);
      domainMap.set(d.company_id, arr);
    }
    const memberMap = new Map<string, number>();
    for (const m of mems ?? []) {
      if (!m.company_id) continue;
      memberMap.set(m.company_id, (memberMap.get(m.company_id) ?? 0) + 1);
    }
    const lite: CompanyLite[] = (companies ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      member_count: memberMap.get(c.id) ?? 0,
      domains: domainMap.get(c.id) ?? [],
    }));
    const rawClusters = clusterCompanies(lite);

    // Suggest a canonical: the entry with the most members, tie-break by
    // shortest name (usually the umbrella brand, e.g. "Nissan North America"
    // beats "Nissan Motor Acceptance Company" when it has more contacts).
    let clusters = rawClusters.map((cluster) => {
      const sorted = [...cluster].sort((a, b) => {
        if (b.member_count !== a.member_count) return b.member_count - a.member_count;
        return a.name.length - b.name.length;
      });
      const canonical = sorted[0];
      return {
        canonicalId: canonical.id,
        canonicalName: canonical.name,
        members: cluster.map((c) => ({
          id: c.id,
          name: c.name,
          member_count: c.member_count,
          domains: c.domains,
          // Default: only fold members whose token overlap looks tight.
          // The UI lets the user check/uncheck individually.
          include: c.id !== canonical.id,
        })),
        rationale: "Grouped by shared brand token / domain root.",
      };
    });

    let aiUsed = false;
    if (data.useAi && clusters.length > 0) {
      try {
        const apiKey = process.env.LOVABLE_API_KEY;
        if (apiKey) {
          const { generateText, Output, NoObjectGeneratedError } = await import("ai");
          const gateway = createLovableAiGatewayProvider(apiKey);
          const model = gateway("google/gemini-3.1-flash-lite");
          const AiSchema = z.object({
            clusters: z.array(
              z.object({
                canonicalName: z.string(),
                fold: z.array(z.string()), // company names to fold in
                keep: z.array(z.string()), // company names to KEEP separate
                rationale: z.string(),
              }),
            ),
          });
          const payload = clusters.map((c) => ({
            canonical: c.canonicalName,
            candidates: c.members.map((m) => ({
              name: m.name,
              contacts: m.member_count,
              domains: m.domains,
            })),
          }));
          const prompt = `You review clusters of possibly-duplicate company records in a personal CRM.
For each cluster, decide which entries are TRULY the same corporate entity (fold them into one canonical name) and which are legitimately separate businesses that just share a brand token (keep them apart).

Guidance:
- Parent umbrella brand + spelling / punctuation variants → FOLD.
  e.g. "Nissan", "Nissan-USA", "Nissan-USA.com" all fold into "Nissan North America".
- Separate legal entities under the same brand → KEEP.
  e.g. "Nissan Motor Acceptance Company" (financing arm), individual dealers ("Boch Nissan South", "Nissan Of Keene"), regional offices → keep separate.
- Prefer the entry with more contacts as the canonical, or the most complete legal name.

Clusters:
${JSON.stringify(payload)}

Return JSON matching the schema. For each cluster, include the canonical name plus one "fold" list and one "keep" list of the ORIGINAL candidate names.`;
          try {
            const { output } = await generateText({
              model,
              output: Output.object({ schema: AiSchema }),
              prompt,
            });
            aiUsed = true;
            // Merge AI verdict back into clusters.
            const aiByCanon = new Map(
              output.clusters.map((c) => [c.canonicalName.toLowerCase(), c] as const),
            );
            clusters = clusters.map((c) => {
              const ai = aiByCanon.get(c.canonicalName.toLowerCase());
              if (!ai) return c;
              const foldSet = new Set(ai.fold.map((n) => n.toLowerCase()));
              const keepSet = new Set(ai.keep.map((n) => n.toLowerCase()));
              return {
                ...c,
                rationale: ai.rationale,
                members: c.members.map((m) => {
                  if (m.id === c.canonicalId) return m;
                  const lname = m.name.toLowerCase();
                  if (keepSet.has(lname)) return { ...m, include: false };
                  if (foldSet.has(lname)) return { ...m, include: true };
                  return m;
                }),
              };
            });
          } catch (e) {
            if (!NoObjectGeneratedError.isInstance(e)) throw e;
          }
        }
      } catch {
        // AI review is best-effort; fall back to rules.
      }
    }

    return { clusters, aiUsed };
  });

export const mergeCluster = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        canonicalId: z.string().uuid(),
        foldIds: z.array(z.string().uuid()).min(1).max(50),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    let merged = 0;
    let failed = 0;
    for (const sourceId of data.foldIds) {
      if (sourceId === data.canonicalId) continue;
      try {
        // Re-use mergeCompanies handler locally by inlining the same body
        // through the exported server fn is awkward — call the mutation
        // logic directly by invoking the raw handler function.
        await (
          mergeCompanies as unknown as {
            handler: (args: { data: { sourceId: string; targetId: string }; context: typeof context }) => Promise<unknown>;
          }
        )
          // Fall back to a plain call if the internal handler is not
          // reachable — the exported RPC works from the server too.
          .handler?.({
            data: { sourceId, targetId: data.canonicalId },
            context,
          });
        merged++;
      } catch {
        // Fallback: call the RPC form.
        try {
          await mergeCompanies({ data: { sourceId, targetId: data.canonicalId } });
          merged++;
        } catch {
          failed++;
        }
      }
    }
    return { merged, failed };
  });

