import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { normalizeCompanyName } from "./company-name";

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
 * Idempotent reconcile: given a group, ensure the auto company subgroups
 * exactly reflect the parent's current direct members. Safe to call whether
 * or not the flag is on (callers should still gate at their side to avoid
 * an extra round trip).
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
  // 1. Load direct members of the parent group + their companies.
  const { data: members, error: mErr } = await supabase
    .from("contact_group_members")
    .select("contact_id, contacts:contacts(id, company)")
    .eq("group_id", parentGroupId);
  if (mErr) throw new Error(mErr.message);

  type MemberRow = {
    contact_id: string;
    contacts: { id: string; company: string | null } | null;
  };
  const rows = (members ?? []) as unknown as MemberRow[];

  // Group contacts by normalized company (skip blank / un-normalizable).
  const byKey = new Map<string, { rawValues: string[]; contactIds: Set<string> }>();
  for (const r of rows) {
    const raw = r.contacts?.company ?? null;
    const key = normalizeCompanyName(raw);
    if (!key) continue;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { rawValues: [], contactIds: new Set() };
      byKey.set(key, bucket);
    }
    if (raw) bucket.rawValues.push(raw);
    bucket.contactIds.add(r.contact_id);
  }

  // 2. Load existing auto subgroups for this parent.
  const { data: existing, error: exErr } = await supabase
    .from("contact_groups")
    .select("id,name")
    .eq("user_id", userId)
    .eq("auto_generated_from_group_id", parentGroupId);
  if (exErr) throw new Error(exErr.message);

  // Existing rows are indexed by normalized(name) so a stored "Hyundai
  // America, Inc." matches the newly-normalized key "hyundai america".
  const existingByKey = new Map<string, { id: string; name: string }>();
  for (const g of existing ?? []) {
    const k = normalizeCompanyName(g.name);
    if (!k) continue;
    // If two auto rows collapse to the same key (legacy data), keep the
    // first and let the delete pass below drop the extras.
    if (!existingByKey.has(k)) existingByKey.set(k, g);
  }

  // 3. Create missing subgroups.
  let created = 0;
  let renamed = 0;
  const wantedKeys = new Set(byKey.keys());
  for (const [key, info] of byKey) {
    const display = pickDisplayName(info.rawValues) || key;
    const existingRow = existingByKey.get(key);
    if (existingRow) {
      // Keep the display label in sync with the most common raw variant.
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

  // 4. Delete auto subgroups whose company disappeared, plus any legacy
  //    duplicates that share a key with a kept row.
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

  // 5. Reconcile members of each remaining auto subgroup.
  let membershipsAdded = 0;
  let membershipsRemoved = 0;
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
          toAdd.map((contact_id) => ({ group_id: g.id, contact_id, user_id: userId })),
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

/** For a set of contacts whose `company` may have changed, find every
 *  parent group with auto-subgroups enabled that has any of them as a
 *  direct member and reconcile it. Deduped per parent group.
 *  Best-effort: individual failures are swallowed. */
export async function reconcileAutoParentsForContacts(
  supabase: DB,
  userId: string,
  contactIds: string[],
): Promise<void> {
  if (contactIds.length === 0) return;
  try {
    const { data: memberships } = await supabase
      .from("contact_group_members")
      .select("group_id")
      .in("contact_id", contactIds);
    const groupIds = Array.from(new Set((memberships ?? []).map((m) => m.group_id)));
    if (groupIds.length === 0) return;
    const { data: parents } = await supabase
      .from("contact_groups")
      .select("id,auto_company_subgroups,user_id")
      .in("id", groupIds)
      .eq("auto_company_subgroups", true);
    for (const p of parents ?? []) {
      if (p.user_id !== userId) continue;
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
