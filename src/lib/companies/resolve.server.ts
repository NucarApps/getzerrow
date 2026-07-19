// Company resolution shared by contact CRUD, Google Contacts pull, and the
// CardDAV PUT handler. Plain server module (no createServerFn) so sync/import
// code can use it without pulling in server-fn machinery.
import { normalizeCompanyName } from "./normalize";

export type ResolveCtx = {
  supabase: import("@supabase/supabase-js").SupabaseClient;
  userId: string;
};

export type ResolvedCompany = { id: string; name: string } | null;

/** Optional per-run memo for batch imports: name_key → resolved company. */
export type CompanyResolveCache = Map<string, ResolvedCompany>;

export async function findOrCreateCompanyByName(
  ctx: ResolveCtx,
  rawName: string,
  cache?: CompanyResolveCache,
): Promise<ResolvedCompany> {
  const name = rawName.trim();
  if (!name) return null;
  const key = normalizeCompanyName(name);
  if (!key) return null;
  if (cache?.has(key)) return cache.get(key) ?? null;

  const resolve = async (): Promise<ResolvedCompany> => {
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
    const aliased = (alias as { companies?: { id: string; name: string } | null } | null)
      ?.companies;
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
  };

  const result = await resolve();
  cache?.set(key, result);
  return result;
}

export async function resolveContactCompany(
  ctx: ResolveCtx,
  companyText: string | null | undefined,
  cache?: CompanyResolveCache,
): Promise<{ companyId: string | null; canonicalName: string | null }> {
  if (companyText === null) return { companyId: null, canonicalName: null };
  if (companyText === undefined) return { companyId: null, canonicalName: null };
  const trimmed = companyText.trim();
  if (!trimmed) return { companyId: null, canonicalName: null };
  const found = await findOrCreateCompanyByName(ctx, trimmed, cache);
  if (!found) return { companyId: null, canonicalName: null };
  return { companyId: found.id, canonicalName: found.name };
}
