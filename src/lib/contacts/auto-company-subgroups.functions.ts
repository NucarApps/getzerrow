import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type DB = SupabaseClient<Database>;

/**
 * Auto company subgroups
 * ----------------------
 * When a group has `auto_company_subgroups=true`, we ensure one child
 * subgroup per distinct `contacts.company` among the parent's direct
 * members. Auto-created subgroups are marked with
 * `auto_generated_from_group_id=<parent>` so we only ever touch rows we own.
 *
 * Contacts stay in the parent group AND get added to their matching
 * company subgroup — the parent view still shows "everyone", the child
 * views slice by company.
 */

const GROUP_SELECT =
  "id,name,color,created_at,folder_id,carddav_uid,updated_at,parent_group_id,auto_company_subgroups,auto_generated_from_group_id";

function normalizeCompany(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ");
}
function companyKey(raw: string | null | undefined): string {
  return normalizeCompany(raw).toLowerCase();
}

async function assertOwnsGroup(supabase: DB, userId: string, groupId: string) {
  const { data, error } = await supabase
    .from("contact_groups")
    .select("id,user_id,auto_company_subgroups")
    .eq("id", groupId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.user_id !== userId) throw new Error("Group not found");
  return data;
}

/**
 * Idempotent reconcile: given a group, ensure the auto company subgroups
 * exactly reflect the parent's current direct members.
 * Safe to call whether or not the flag is on — if it's off this is a no-op
 * (callers should still gate at their side to avoid an extra round trip).
 */
export async function reconcileAutoCompanySubgroupsImpl(
  supabase: DB,
  userId: string,
  parentGroupId: string,
): Promise<{ created: number; removed: number; membershipsAdded: number; membershipsRemoved: number }> {
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

  // Group contacts by normalized company (skip blank).
  const byKey = new Map<string, { display: string; contactIds: Set<string> }>();
  for (const r of rows) {
    const raw = r.contacts?.company ?? null;
    const key = companyKey(raw);
    if (!key) continue;
    const display = normalizeCompany(raw);
    if (!byKey.has(key)) byKey.set(key, { display, contactIds: new Set() });
    byKey.get(key)!.contactIds.add(r.contact_id);
  }

  // 2. Load existing auto subgroups for this parent.
  const { data: existing, error: exErr } = await supabase
    .from("contact_groups")
    .select("id,name")
    .eq("user_id", userId)
    .eq("auto_generated_from_group_id", parentGroupId);
  if (exErr) throw new Error(exErr.message);

  const existingByKey = new Map<string, { id: string; name: string }>();
  for (const g of existing ?? []) existingByKey.set(g.name.trim().toLowerCase(), g);

  // 3. Create missing subgroups.
  let created = 0;
  const wantedKeys = new Set(byKey.keys());
  for (const [key, info] of byKey) {
    if (existingByKey.has(key)) continue;
    const uid =
      "group-" +
      (globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const { data: ins, error: iErr } = await supabase
      .from("contact_groups")
      .insert({
        user_id: userId,
        name: info.display,
        color: "#6366f1",
        carddav_uid: uid,
        parent_group_id: parentGroupId,
        auto_generated_from_group_id: parentGroupId,
      })
      .select("id,name")
      .single();
    if (iErr) {
      // Name collision with a user-created group of the same name is fine;
      // we simply skip that key and don't manage that group.
      if (!/duplicate|unique/i.test(iErr.message)) throw new Error(iErr.message);
      continue;
    }
    existingByKey.set(key, ins);
    created++;
  }

  // 4. Delete auto subgroups whose company disappeared.
  let removed = 0;
  for (const [key, g] of existingByKey) {
    if (wantedKeys.has(key)) continue;
    const { error: dErr } = await supabase.from("contact_groups").delete().eq("id", g.id);
    if (dErr) throw new Error(dErr.message);
    existingByKey.delete(key);
    removed++;
  }

  // 5. Reconcile members of each remaining auto subgroup.
  let membershipsAdded = 0;
  let membershipsRemoved = 0;
  for (const [key, g] of existingByKey) {
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

  return { created, removed, membershipsAdded, membershipsRemoved };
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
    await assertOwnsGroup(supabase, userId, data.groupId);
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
