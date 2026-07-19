// Shared resolve-or-create for labels that name companies. Every label
// create path routes through here so "Nissan", "Nissan, Inc." and a
// merged-away "Nissan Motor Acceptance Company" all land on ONE
// contact_groups row instead of minting duplicates. Plain server module
// (no createServerFn), modeled on companies/resolve.server.ts, so both
// user-scoped server fns and admin sync/import code can call it.
import { deriveLabelKey, pickExistingLabel } from "./label-resolve";

export type LabelResolveCtx = {
  supabase: import("@supabase/supabase-js").SupabaseClient;
  userId: string;
};

export type ResolvedLabel = {
  id: string;
  name: string;
  created: boolean;
};

/** Per-run memo for batch imports: `${parentScope}::${key}` → label. */
export type LabelResolveCache = Map<string, ResolvedLabel>;

export function newGroupCardDavUid(): string {
  return (
    "group-" +
    (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  );
}

/** Load the alias map used for key derivation: mild name_key of a
 * merged-away company name → the canonical company's display name. */
export async function loadNameAliasMap(ctx: LabelResolveCtx): Promise<Map<string, string>> {
  const { data } = await ctx.supabase
    .from("company_name_aliases")
    .select("name_key, companies:companies(name)")
    .eq("user_id", ctx.userId);
  const map = new Map<string, string>();
  for (const row of (data ?? []) as unknown as Array<{
    name_key: string | null;
    // Supabase types FK joins as arrays; runtime gives an object. Accept both.
    companies: { name: string } | Array<{ name: string }> | null;
  }>) {
    const company = Array.isArray(row.companies) ? row.companies[0] : row.companies;
    if (row.name_key && company?.name) map.set(row.name_key, company.name);
  }
  return map;
}

export async function resolveOrCreateCompanyLabel(
  ctx: LabelResolveCtx,
  args: {
    rawName: string;
    parentGroupId?: string | null;
    /** When the label names a known company, pass its id so the company's
     * linked label is preferred and back-filled. */
    companyId?: string | null;
    color?: string;
    /** Extra columns for a fresh insert (e.g. auto_generated_from_group_id). */
    extraInsert?: Record<string, unknown>;
    /** Pre-loaded alias map (loadNameAliasMap) to skip the per-call fetch. */
    nameAliases?: Map<string, string>;
    cache?: LabelResolveCache;
  },
): Promise<ResolvedLabel | null> {
  const name = args.rawName.trim();
  if (!name) return null;
  const parentGroupId = args.parentGroupId ?? null;
  const aliases = args.nameAliases ?? (await loadNameAliasMap(ctx));
  const { key } = deriveLabelKey(name, aliases);
  if (!key) return null;
  const cacheKey = `${parentGroupId ?? "__root__"}::${key}`;
  const cached = args.cache?.get(cacheKey);
  if (cached) return cached;

  const finish = async (label: ResolvedLabel): Promise<ResolvedLabel> => {
    // Companies are the settable source of truth: remember which label
    // represents this company so future resolutions short-circuit.
    if (args.companyId) {
      const { data: comp } = await ctx.supabase
        .from("companies")
        .select("linked_group_id")
        .eq("id", args.companyId)
        .eq("user_id", ctx.userId)
        .maybeSingle();
      if (comp && (comp as { linked_group_id: string | null }).linked_group_id === null) {
        await ctx.supabase
          .from("companies")
          .update({ linked_group_id: label.id })
          .eq("id", args.companyId)
          .eq("user_id", ctx.userId);
      }
    }
    args.cache?.set(cacheKey, label);
    return label;
  };

  // 1. The company's linked label wins when it lives in the requested scope.
  if (args.companyId) {
    const { data: comp } = await ctx.supabase
      .from("companies")
      .select("linked_group_id")
      .eq("id", args.companyId)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    const linkedId = (comp as { linked_group_id: string | null } | null)?.linked_group_id;
    if (linkedId) {
      const { data: linked } = await ctx.supabase
        .from("contact_groups")
        .select("id,name,parent_group_id")
        .eq("id", linkedId)
        .eq("user_id", ctx.userId)
        .maybeSingle();
      if (
        linked &&
        ((linked as { parent_group_id: string | null }).parent_group_id ?? null) === parentGroupId
      ) {
        return finish({ id: linked.id, name: linked.name, created: false });
      }
    }
  }

  // 2. Key match among labels already in scope.
  const scopedQuery = ctx.supabase
    .from("contact_groups")
    .select("id,name,parent_group_id")
    .eq("user_id", ctx.userId);
  const { data: candidates } = await (parentGroupId
    ? scopedQuery.eq("parent_group_id", parentGroupId)
    : scopedQuery.is("parent_group_id", null));
  const hit = pickExistingLabel(
    name,
    parentGroupId,
    (candidates ?? []) as Array<{ id: string; name: string; parent_group_id: string | null }>,
    aliases,
  );
  if (hit) return finish({ id: hit.id, name: hit.name, created: false });

  // 3. Insert; on a unique-name race, re-select the winner.
  const { data: inserted, error: insErr } = await ctx.supabase
    .from("contact_groups")
    .insert({
      user_id: ctx.userId,
      name,
      color: args.color ?? "#6366f1",
      carddav_uid: newGroupCardDavUid(),
      parent_group_id: parentGroupId,
      ...(args.extraInsert ?? {}),
    })
    .select("id,name")
    .single();
  if (insErr) {
    // Race or unique-index hit. First re-run the in-scope key match (covers
    // the scoped name_key index, where the winner's spelling may differ);
    // then fall back to a byte-name lookup across scopes (the legacy global
    // (user_id, lower(name)) index).
    const retryQuery = ctx.supabase
      .from("contact_groups")
      .select("id,name,parent_group_id")
      .eq("user_id", ctx.userId);
    const { data: retryCandidates } = await (parentGroupId
      ? retryQuery.eq("parent_group_id", parentGroupId)
      : retryQuery.is("parent_group_id", null));
    const retryHit = pickExistingLabel(
      name,
      parentGroupId,
      (retryCandidates ?? []) as Array<{
        id: string;
        name: string;
        parent_group_id: string | null;
      }>,
      aliases,
    );
    if (retryHit) return finish({ id: retryHit.id, name: retryHit.name, created: false });
    const { data: retry } = await ctx.supabase
      .from("contact_groups")
      .select("id,name")
      .eq("user_id", ctx.userId)
      .ilike("name", name)
      .limit(1)
      .maybeSingle();
    if (retry) return finish({ id: retry.id, name: retry.name, created: false });
    throw new Error(insErr.message);
  }
  return finish({ id: inserted.id, name: inserted.name, created: true });
}
