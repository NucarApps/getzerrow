import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { normalizeCompanyName } from "./company-name";
import { deriveCompanyKey, type CompanyKeyContext } from "./company-key";

type ContactShape = {
  id: string;
  company: string | null;
  email: string | null;
  website: string | null;
  company_id: string | null;
};



type DB = SupabaseClient<Database>;

/**
 * Auto company subgroups
 * ----------------------
 * When a group has `auto_company_subgroups=true`, we ensure one child
 * subgroup per distinct normalized company among the parent's direct
 * members. Auto-created subgroups are marked with
 * `auto_generated_from_group_id=<parent>` so we only ever touch rows we own.
 *
 * The subgroup key is derived via `normalizeCompanyName` — so cleaning up
 * "Hyundai America, Inc." to just "Hyundai America" collapses two auto
 * subgroups into one on the next reconcile. Reconcile fires automatically
 * whenever membership or a member's `company` field changes.
 *
 * Auto subgroups are managed rows: the UI hides edit affordances and the
 * server rejects direct writes (see contact-groups.functions.ts).
 */

const GROUP_SELECT =
  "id,name,color,created_at,folder_id,carddav_uid,updated_at,parent_group_id,auto_company_subgroups,auto_generated_from_group_id";

function trimRaw(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ");
}

/** Pick a human-friendly display name for a subgroup from the raw company
 *  strings of its members. Most common wins; ties broken by longest then
 *  alphabetical for stability. */
function pickDisplayName(rawValues: string[]): string {
  const counts = new Map<string, number>();
  for (const raw of rawValues) {
    const v = trimRaw(raw);
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const entries = [...counts.entries()];
  if (entries.length === 0) return "";
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    if (b[0].length !== a[0].length) return b[0].length - a[0].length;
    return a[0].localeCompare(b[0]);
  });
  return entries[0][0];
}

async function assertOwnsGroup(supabase: DB, userId: string, groupId: string) {
  const { data, error } = await supabase
    .from("contact_groups")
    .select("id,user_id,auto_company_subgroups,auto_generated_from_group_id")
    .eq("id", groupId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.user_id !== userId) throw new Error("Group not found");
  return data;
}

/**
 * Idempotent reconcile: for a parent group `P` with auto-company-subgroups
 * enabled, ensure that every contact whose normalized `company` matches a
 * company represented by `P`'s manual members is present in `P` (as an
 * `auto_added=true` row) and in the matching auto subgroup. Auto subgroups
 * are created/renamed/removed to match the represented-companies set.
 * Manual memberships (`auto_added=false`) are never touched.
 */
export async function reconcileAutoCompanySubgroupsImpl(
  supabase: DB,
  userId: string,
  parentGroupId: string,
): Promise<{
  created: number;
  removed: number;
  renamed: number;
  membershipsAdded: number;
  membershipsRemoved: number;
}> {
  // 0. Load lookup maps: domain aliases, every company name, merged-name
  //    aliases, and domain→company links, so all key derivations resolve
  //    fragmented/merged company variants to one canonical bucket.
  const [
    { data: aliasRows },
    { data: allCompanyRows },
    { data: nameAliasRows },
    { data: companyDomainRows },
  ] = await Promise.all([
    supabase
      .from("company_aliases")
      .select("primary_domain, alias_domain")
      .eq("user_id", userId),
    supabase.from("companies").select("id,name").eq("user_id", userId),
    supabase
      .from("company_name_aliases")
      .select("name_key,company_id")
      .eq("user_id", userId),
    supabase
      .from("company_domains")
      .select("domain,company_id")
      .eq("user_id", userId),
  ]);
  const aliasMap = new Map<string, string>();
  for (const r of aliasRows ?? []) {
    if (r.alias_domain && r.primary_domain) aliasMap.set(r.alias_domain, r.primary_domain);
  }
  const companyMap = new Map<string, string>();
  for (const c of allCompanyRows ?? []) {
    if (c.id && c.name) companyMap.set(c.id, c.name);
  }
  const nameAliases = new Map<string, string>();
  for (const r of (nameAliasRows ?? []) as Array<{
    name_key: string;
    company_id: string | null;
  }>) {
    const canonical = r.company_id ? companyMap.get(r.company_id) : null;
    if (r.name_key && canonical) nameAliases.set(r.name_key, canonical);
  }
  const companyIdByDomain = new Map<string, string>();
  for (const r of (companyDomainRows ?? []) as Array<{
    domain: string;
    company_id: string;
  }>) {
    if (r.domain && r.company_id) companyIdByDomain.set(r.domain, r.company_id);
  }
  const keyCtx: CompanyKeyContext = {
    domainAliases: aliasMap,
    companiesById: companyMap,
    nameAliases,
    companyIdByDomain,
  };

  // 1. Load direct members of the parent, split by auto/manual.
  const { data: members, error: mErr } = await supabase
    .from("contact_group_members")
    .select("contact_id, auto_added, contacts:contacts(id, company, email, website, company_id)")
    .eq("group_id", parentGroupId);
  if (mErr) throw new Error(mErr.message);

  type MemberRow = {
    contact_id: string;
    auto_added: boolean | null;
    contacts: ContactShape | null;
  };
  const rows = (members ?? []) as unknown as MemberRow[];

  const manualIds = new Set<string>();
  const manualContacts: ContactShape[] = [];
  for (const r of rows) {
    if (r.auto_added) continue;
    manualIds.add(r.contact_id);
    if (r.contacts) manualContacts.push(r.contacts);
  }

  // 2. Represented-companies = distinct normalized key across manual members,
  //    derived from `company_id` (preferred), then `company`, then domain.
  const repKeys = new Set<string>();
  const fallbackDisplayNames = new Map<string, string>();
  for (const c of manualContacts) {
    const derived = deriveCompanyKey(c, keyCtx);
    if (!derived) continue;
    repKeys.add(derived.key);
    if (!derived.rawCompany && !fallbackDisplayNames.has(derived.key)) {
      fallbackDisplayNames.set(derived.key, derived.displayName);
    }
  }

  // 3. Load every user contact and bucket by derived key.
  const byKey = new Map<
    string,
    { rawValues: string[]; companyNames: string[]; contactIds: Set<string> }
  >();
  if (repKeys.size > 0) {
    const { data: allContacts, error: cErr } = await supabase
      .from("contacts")
      .select("id, company, email, website, company_id")
      .eq("user_id", userId);
    if (cErr) throw new Error(cErr.message);
    for (const c of (allContacts ?? []) as ContactShape[]) {
      const derived = deriveCompanyKey(c, keyCtx);
      if (!derived || !repKeys.has(derived.key)) continue;
      let bucket = byKey.get(derived.key);
      if (!bucket) {
        bucket = { rawValues: [], companyNames: [], contactIds: new Set() };
        byKey.set(derived.key, bucket);
      }
      if (derived.fromCompany) bucket.companyNames.push(derived.displayName);
      else if (derived.rawCompany) bucket.rawValues.push(derived.rawCompany);
      bucket.contactIds.add(c.id);
    }
    // Ensure every represented key exists, even if no candidate matched.
    for (const key of repKeys) {
      if (!byKey.has(key)) {
        byKey.set(key, { rawValues: [], companyNames: [], contactIds: new Set() });
      }
    }
  }


  // 4. Load existing auto subgroups for this parent.
  const { data: existing, error: exErr } = await supabase
    .from("contact_groups")
    .select("id,name")
    .eq("user_id", userId)
    .eq("auto_generated_from_group_id", parentGroupId);
  if (exErr) throw new Error(exErr.message);

  const existingByKey = new Map<string, { id: string; name: string }>();
  for (const g of existing ?? []) {
    const k = normalizeCompanyName(g.name);
    if (!k) continue;
    if (!existingByKey.has(k)) existingByKey.set(k, g);
  }

  const wantedKeys = new Set(byKey.keys());

  // Legacy auto subgroups may be named from old free-text company values
  // while the current bucket key is the canonical Company entity id. Alias
  // those existing groups by the company-id-derived key of their members so
  // they are renamed in place instead of replaced.
  const existingIds = (existing ?? []).map((group) => group.id);
  if (existingIds.length > 0) {
    const { data: subgroupMembers } = await supabase
      .from("contact_group_members")
      .select("group_id, contacts:contacts(id, company, email, website, company_id)")
      .in("group_id", existingIds);
    type SubgroupMemberRow = {
      group_id: string;
      contacts: ContactShape | null;
    };
    const existingById = new Map((existing ?? []).map((group) => [group.id, group]));
    for (const row of (subgroupMembers ?? []) as unknown as SubgroupMemberRow[]) {
      if (!row.contacts) continue;
      const derived = deriveCompanyKey(row.contacts, keyCtx);
      const existingGroup = existingById.get(row.group_id);
      if (!derived || !existingGroup || !wantedKeys.has(derived.key)) continue;
      if (!existingByKey.has(derived.key)) existingByKey.set(derived.key, existingGroup);
    }
  }

  // 5. Create/rename subgroups for each represented key. Company-entity
  //    names win over raw free-text values when naming the subgroup.
  let created = 0;
  let renamed = 0;
  for (const [key, info] of byKey) {
    const display =
      pickDisplayName(info.companyNames) ||
      pickDisplayName(info.rawValues) ||
      fallbackDisplayNames.get(key) ||
      key;
    const existingRow = existingByKey.get(key);
    if (existingRow) {
      if (existingRow.name !== display) {
        const { error: rnErr } = await supabase
          .from("contact_groups")
          .update({ name: display })
          .eq("id", existingRow.id);
        if (!rnErr) {
          existingRow.name = display;
          renamed++;
        }
      }
      continue;
    }
    const uid =
      "group-" +
      (globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const { data: ins, error: iErr } = await supabase
      .from("contact_groups")
      .insert({
        user_id: userId,
        name: display,
        color: "#6366f1",
        carddav_uid: uid,
        parent_group_id: parentGroupId,
        auto_generated_from_group_id: parentGroupId,
      })
      .select("id,name")
      .single();
    if (iErr) {
      if (!/duplicate|unique/i.test(iErr.message)) throw new Error(iErr.message);
      continue;
    }
    existingByKey.set(key, ins);
    created++;
  }

  // 6. Delete stale auto subgroups + legacy duplicates.
  let removed = 0;
  const keptIds = new Set<string>();
  for (const [key, g] of existingByKey) {
    if (wantedKeys.has(key)) keptIds.add(g.id);
  }
  const toDeleteIds: string[] = [];
  for (const g of existing ?? []) {
    if (!keptIds.has(g.id)) toDeleteIds.push(g.id);
  }
  if (toDeleteIds.length > 0) {
    const { error: dErr } = await supabase
      .from("contact_groups")
      .delete()
      .in("id", toDeleteIds);
    if (dErr) throw new Error(dErr.message);
    removed = toDeleteIds.length;
  }

  // 7. Reconcile parent-group auto memberships. wantedAutoIds = every
  //    matched contact that isn't already a manual member of the parent.
  const wantedAutoIds = new Set<string>();
  for (const bucket of byKey.values()) {
    for (const cid of bucket.contactIds) {
      if (!manualIds.has(cid)) wantedAutoIds.add(cid);
    }
  }
  const currentAutoIds = new Set<string>();
  for (const r of rows) {
    if (r.auto_added) currentAutoIds.add(r.contact_id);
  }
  const parentToAdd: string[] = [];
  for (const cid of wantedAutoIds) if (!currentAutoIds.has(cid)) parentToAdd.push(cid);
  const parentToRemove: string[] = [];
  for (const cid of currentAutoIds) if (!wantedAutoIds.has(cid)) parentToRemove.push(cid);

  let membershipsAdded = 0;
  let membershipsRemoved = 0;
  if (parentToAdd.length > 0) {
    const { error: aErr } = await supabase.from("contact_group_members").upsert(
      parentToAdd.map((contact_id) => ({
        group_id: parentGroupId,
        contact_id,
        user_id: userId,
        auto_added: true,
      })),
      { onConflict: "group_id,contact_id", ignoreDuplicates: true },
    );
    if (aErr) throw new Error(aErr.message);
    membershipsAdded += parentToAdd.length;
  }
  if (parentToRemove.length > 0) {
    const { error: rErr } = await supabase
      .from("contact_group_members")
      .delete()
      .eq("group_id", parentGroupId)
      .eq("auto_added", true)
      .in("contact_id", parentToRemove);
    if (rErr) throw new Error(rErr.message);
    membershipsRemoved += parentToRemove.length;
  }

  // 8. Reconcile subgroup memberships: each auto subgroup contains every
  //    matched contact for its key (manual + auto in parent).
  for (const [key, g] of existingByKey) {
    if (!wantedKeys.has(key)) continue;
    const wanted = byKey.get(key)?.contactIds ?? new Set<string>();
    const { data: currentMembers, error: cErr } = await supabase
      .from("contact_group_members")
      .select("contact_id")
      .eq("group_id", g.id);
    if (cErr) throw new Error(cErr.message);
    const current = new Set((currentMembers ?? []).map((r) => r.contact_id));

    const toAdd: string[] = [];
    for (const cid of wanted) if (!current.has(cid)) toAdd.push(cid);
    const toRemove: string[] = [];
    for (const cid of current) if (!wanted.has(cid)) toRemove.push(cid);

    if (toAdd.length > 0) {
      const { error: aErr } = await supabase
        .from("contact_group_members")
        .upsert(
          toAdd.map((contact_id) => ({
            group_id: g.id,
            contact_id,
            user_id: userId,
            auto_added: true,
          })),
          { onConflict: "group_id,contact_id", ignoreDuplicates: true },
        );
      if (aErr) throw new Error(aErr.message);
      membershipsAdded += toAdd.length;
    }
    if (toRemove.length > 0) {
      const { error: rErr } = await supabase
        .from("contact_group_members")
        .delete()
        .eq("group_id", g.id)
        .in("contact_id", toRemove);
      if (rErr) throw new Error(rErr.message);
      membershipsRemoved += toRemove.length;
    }
  }

  return { created, removed, renamed, membershipsAdded, membershipsRemoved };
}

/** Best-effort trigger used from other server fns; swallow errors so the
 *  primary write (add/remove contacts) never fails because of subgroup
 *  reconcile problems. */
export async function reconcileIfAuto(
  supabase: DB,
  userId: string,
  groupId: string,
): Promise<void> {
  try {
    const { data } = await supabase
      .from("contact_groups")
      .select("auto_company_subgroups,user_id")
      .eq("id", groupId)
      .maybeSingle();
    if (!data || data.user_id !== userId || !data.auto_company_subgroups) return;
    await reconcileAutoCompanySubgroupsImpl(supabase, userId, groupId);
  } catch {
    // Non-fatal.
  }
}

/** For a set of contacts whose `company` may have changed, reconcile every
 *  parent group with auto-subgroups enabled. We can't just look at the
 *  parents the contacts are already members of — a company change may
 *  newly qualify them for a parent they've never been in. Best-effort:
 *  individual failures are swallowed. */
export async function reconcileAutoParentsForContacts(
  supabase: DB,
  userId: string,
  contactIds: string[],
): Promise<void> {
  if (contactIds.length === 0) return;
  try {
    const { data: parents } = await supabase
      .from("contact_groups")
      .select("id,user_id")
      .eq("user_id", userId)
      .eq("auto_company_subgroups", true);
    for (const p of parents ?? []) {
      try {
        await reconcileAutoCompanySubgroupsImpl(supabase, userId, p.id);
      } catch {
        // Non-fatal per parent.
      }
    }
  } catch {
    // Non-fatal.
  }
}

/** Reconcile every auto-company-subgroup parent for the current user.
 *  Used by the one-time backfill on the contacts page. */
export const reconcileAllAutoGroups = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: parents, error } = await supabase
      .from("contact_groups")
      .select("id")
      .eq("user_id", userId)
      .eq("auto_company_subgroups", true);
    if (error) throw new Error(error.message);
    let totalAdded = 0;
    let totalRemoved = 0;
    let reconciled = 0;
    for (const p of parents ?? []) {
      try {
        const s = await reconcileAutoCompanySubgroupsImpl(supabase, userId, p.id);
        totalAdded += s.membershipsAdded;
        totalRemoved += s.membershipsRemoved;
        reconciled += 1;
      } catch {
        // Skip failing parents; keep going.
      }
    }
    return { reconciled, membershipsAdded: totalAdded, membershipsRemoved: totalRemoved };
  });

/** Flip the toggle. When enabling, run an immediate reconcile so the user
 *  sees subgroups right away. Disabling leaves auto rows in place until
 *  the user explicitly prunes. */
export const setAutoCompanySubgroups = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { groupId: string; enabled: boolean }) =>
    z.object({ groupId: z.string().uuid(), enabled: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const g = await assertOwnsGroup(supabase, userId, data.groupId);
    if (g.auto_generated_from_group_id) {
      throw new Error("This subgroup is managed automatically");
    }
    const { error } = await supabase
      .from("contact_groups")
      .update({ auto_company_subgroups: data.enabled })
      .eq("id", data.groupId);
    if (error) throw new Error(error.message);
    let stats = null as null | Awaited<ReturnType<typeof reconcileAutoCompanySubgroupsImpl>>;
    if (data.enabled) {
      stats = await reconcileAutoCompanySubgroupsImpl(supabase, userId, data.groupId);
    }
    return { ok: true, stats };
  });

/** Manual re-run for the "Re-scan now" button. */
export const reconcileAutoCompanySubgroups = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { groupId: string }) =>
    z.object({ groupId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertOwnsGroup(supabase, userId, data.groupId);
    const stats = await reconcileAutoCompanySubgroupsImpl(supabase, userId, data.groupId);
    return { ok: true, stats };
  });

/** Delete every auto-generated subgroup under `groupId`. Used by the
 *  "Remove auto subgroups" cleanup button. */
export const pruneAutoCompanySubgroups = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { groupId: string }) =>
    z.object({ groupId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertOwnsGroup(supabase, userId, data.groupId);
    const { data: rows, error } = await supabase
      .from("contact_groups")
      .select("id")
      .eq("user_id", userId)
      .eq("auto_generated_from_group_id", data.groupId);
    if (error) throw new Error(error.message);
    const ids = (rows ?? []).map((r) => r.id);
    if (ids.length === 0) return { removed: 0 };
    const { error: dErr } = await supabase.from("contact_groups").delete().in("id", ids);
    if (dErr) throw new Error(dErr.message);
    return { removed: ids.length };
  });

// Suppress lint for unused GROUP_SELECT — kept for parity with other files
// and possible future selects that want the full shape.
void GROUP_SELECT;
