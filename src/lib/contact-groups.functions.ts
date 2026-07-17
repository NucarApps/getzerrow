import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { reconcileIfAuto } from "./contacts/auto-company-subgroups.functions";

type DB = SupabaseClient<Database>;

const COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const MAX_DEPTH = 4;

const GROUP_SELECT =
  "id,name,color,created_at,folder_id,carddav_uid,updated_at,parent_group_id,auto_company_subgroups,auto_generated_from_group_id";

/** List the user's groups with member counts and any linked folder. */
export const listContactGroups = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const [{ data: groups, error: gErr }, { data: members, error: mErr }] = await Promise.all([
      supabase
        .from("contact_groups")
        .select(GROUP_SELECT)
        .order("name", { ascending: true }),
      supabase.from("contact_group_members").select("group_id,contact_id"),
    ]);
    if (gErr) throw new Error(gErr.message);
    if (mErr) throw new Error(mErr.message);

    const counts = new Map<string, number>();
    for (const m of members ?? []) counts.set(m.group_id, (counts.get(m.group_id) ?? 0) + 1);

    // Load folder names for linked folders so the UI can show a chip
    // without a second round trip.
    const folderIds = Array.from(
      new Set(
        ((groups ?? [])
          .map((g) => g.folder_id)
          .filter((v): v is string => !!v)) as string[],
      ),
    );
    let folderById = new Map<string, { name: string; color: string | null }>();
    if (folderIds.length > 0) {
      const { data: folders } = await supabase
        .from("folders")
        .select("id,name,color")
        .in("id", folderIds);
      folderById = new Map(
        (folders ?? []).map((f) => [f.id, { name: f.name, color: f.color ?? null }]),
      );
    }

    return {
      groups: (groups ?? []).map((g) => ({
        ...g,
        count: counts.get(g.id) ?? 0,
        linked_folder: g.folder_id ? (folderById.get(g.folder_id) ?? null) : null,
      })),
      memberships: (members ?? []) as { group_id: string; contact_id: string }[],
    };
  });

export const createContactGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { name: string; color?: string; parent_group_id?: string | null }) =>
    z
      .object({
        name: z.string().min(1).max(60),
        color: COLOR.optional(),
        parent_group_id: z.string().uuid().nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Validate parent depth (max MAX_DEPTH levels: root=1..MAX_DEPTH).
    if (data.parent_group_id) {
      const { parents } = await loadParentMap(supabase, userId);
      const depth = chainDepth(parents, data.parent_group_id);
      if (depth + 1 > MAX_DEPTH) {
        throw new Error(`Groups can only nest ${MAX_DEPTH} levels deep`);
      }
    }
    // Generate a stable CardDAV UID up-front so a group created in the
    // web app is immediately visible/syncable to iPhones on next PROPFIND.
    const uid =
      "group-" +
      (globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const { data: row, error } = await supabase
      .from("contact_groups")
      .insert({
        user_id: userId,
        name: data.name.trim(),
        color: data.color ?? "#6366f1",
        carddav_uid: uid,
        parent_group_id: data.parent_group_id ?? null,
      })
      .select(GROUP_SELECT)
      .single();
    if (error) throw new Error(error.message);
    return { group: row };
  });

export const updateContactGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { id: string; name?: string; color?: string; parent_group_id?: string | null }) =>
      z
        .object({
          id: z.string().uuid(),
          name: z.string().min(1).max(60).optional(),
          color: COLOR.optional(),
          parent_group_id: z.string().uuid().nullable().optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { id, parent_group_id, ...rest } = data;
    // Cycle + depth guard when reparenting.
    if (parent_group_id !== undefined && parent_group_id !== null) {
      if (parent_group_id === id) throw new Error("A group can't be its own parent");
      const { parents } = await loadParentMap(supabase, userId);
      // Walk the proposed parent's ancestry: if `id` appears, it's a cycle.
      let cursor: string | null = parent_group_id;
      let hops = 0;
      while (cursor && hops < 32) {
        if (cursor === id) throw new Error("That would create a cycle");
        cursor = parents.get(cursor) ?? null;
        hops++;
      }
      const depth = chainDepth(parents, parent_group_id);
      if (depth + 1 > MAX_DEPTH) {
        throw new Error(`Groups can only nest ${MAX_DEPTH} levels deep`);
      }
    }
    const patch: {
      name?: string;
      color?: string;
      parent_group_id?: string | null;
    } = { ...rest };
    if (parent_group_id !== undefined) patch.parent_group_id = parent_group_id;
    const { data: row, error } = await supabase
      .from("contact_groups")
      .update(patch)
      .eq("id", id)
      .select(GROUP_SELECT)
      .single();
    if (error) throw new Error(error.message);
    return { group: row };
  });

export const deleteContactGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase.from("contact_groups").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Load every group's `parent_group_id` for the user into a map so we can
 * walk ancestry in memory instead of round-tripping per hop. Group counts
 * are tiny per user, so this is cheap. */
async function loadParentMap(
  supabase: DB,
  userId: string,
): Promise<{ parents: Map<string, string | null> }> {
  const { data, error } = await supabase
    .from("contact_groups")
    .select("id,parent_group_id")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  const parents = new Map<string, string | null>();
  for (const r of data ?? []) parents.set(r.id, r.parent_group_id ?? null);
  return { parents };
}

/** Depth of the chain rooted at `startId`. 1 = the group itself has no
 * parent. Bounded loop stops runaway data from freezing the request. */
function chainDepth(parents: Map<string, string | null>, startId: string): number {
  let cursor: string | null = startId;
  let depth = 0;
  while (cursor && depth < 32) {
    depth++;
    cursor = parents.get(cursor) ?? null;
  }
  return depth;
}

/** Replace the set of groups a contact belongs to. */
export const setContactGroups = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { contactId: string; groupIds: string[] }) =>
    z
      .object({
        contactId: z.string().uuid(),
        groupIds: z.array(z.string().uuid()).max(50),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Capture the groups this contact currently belongs to so we can also
    // reconcile any auto-parent that just lost the contact.
    const { data: prev } = await supabase
      .from("contact_group_members")
      .select("group_id")
      .eq("contact_id", data.contactId);
    const affected = new Set<string>((prev ?? []).map((r) => r.group_id));

    const { error: delErr } = await supabase
      .from("contact_group_members")
      .delete()
      .eq("contact_id", data.contactId);
    if (delErr) throw new Error(delErr.message);

    if (data.groupIds.length > 0) {
      const rows = data.groupIds.map((group_id) => ({
        group_id,
        contact_id: data.contactId,
        user_id: userId,
      }));
      const { error: insErr } = await supabase.from("contact_group_members").insert(rows);
      if (insErr) throw new Error(insErr.message);
      for (const gid of data.groupIds) affected.add(gid);
    }
    for (const gid of affected) await reconcileIfAuto(supabase, userId, gid);
    return { ok: true };
  });

/** Add many contacts to a group (idempotent). */
export const addContactsToGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { groupId: string; contactIds: string[] }) =>
    z
      .object({
        groupId: z.string().uuid(),
        contactIds: z.array(z.string().uuid()).min(1).max(1000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const rows = data.contactIds.map((contact_id) => ({
      group_id: data.groupId,
      contact_id,
      user_id: userId,
    }));
    const { error } = await supabase
      .from("contact_group_members")
      .upsert(rows, { onConflict: "group_id,contact_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    return { added: rows.length };
  });

/** Add many contacts to many groups in one batch (idempotent). Used by the
 * bulk multi-select "Add to group…" action on the contacts list. */
export const addContactsToGroups = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { groupIds: string[]; contactIds: string[] }) =>
    z
      .object({
        groupIds: z.array(z.string().uuid()).min(1).max(50),
        contactIds: z.array(z.string().uuid()).min(1).max(1000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const rows: { group_id: string; contact_id: string; user_id: string }[] = [];
    for (const gid of data.groupIds) {
      for (const cid of data.contactIds) {
        rows.push({ group_id: gid, contact_id: cid, user_id: userId });
      }
    }
    const { error } = await supabase
      .from("contact_group_members")
      .upsert(rows, { onConflict: "group_id,contact_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    return { added: rows.length };
  });

/** Remove many contacts from one group (idempotent). */
export const removeContactsFromGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { groupId: string; contactIds: string[] }) =>
    z
      .object({
        groupId: z.string().uuid(),
        contactIds: z.array(z.string().uuid()).min(1).max(1000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("contact_group_members")
      .delete()
      .eq("group_id", data.groupId)
      .in("contact_id", data.contactIds);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Link (or unlink) a contact group to a folder. When linked, emails from
 * any member of the group are auto-filed to the folder via a
 * `sender_in_group` folder_filters row. Unlinking removes that row. */
export const linkContactGroupToFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { groupId: string; folderId: string | null }) =>
    z
      .object({
        groupId: z.string().uuid(),
        folderId: z.string().uuid().nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Verify the group belongs to the caller and read its current link.
    const { data: group, error: gErr } = await supabase
      .from("contact_groups")
      .select("id,user_id,folder_id")
      .eq("id", data.groupId)
      .maybeSingle();
    if (gErr) throw new Error(gErr.message);
    if (!group || group.user_id !== userId) throw new Error("Group not found");

    // Verify target folder ownership when linking.
    if (data.folderId) {
      const { data: folder, error: fErr } = await supabase
        .from("folders")
        .select("id,user_id")
        .eq("id", data.folderId)
        .maybeSingle();
      if (fErr) throw new Error(fErr.message);
      if (!folder || folder.user_id !== userId) throw new Error("Folder not found");
    }

    // Remove any previous sender_in_group filter row for this group across
    // any folder it may have been linked to.
    const { error: delErr } = await supabase
      .from("folder_filters")
      .delete()
      .eq("op", "sender_in_group")
      .eq("value", data.groupId);
    if (delErr) throw new Error(delErr.message);

    // Update the group's folder link.
    const { error: upErr } = await supabase
      .from("contact_groups")
      .update({ folder_id: data.folderId })
      .eq("id", data.groupId);
    if (upErr) throw new Error(upErr.message);

    // Insert the new filter row when linking.
    if (data.folderId) {
      const { error: insErr } = await supabase.from("folder_filters").insert({
        folder_id: data.folderId,
        field: "from",
        op: "sender_in_group",
        value: data.groupId,
      });
      if (insErr) throw new Error(insErr.message);
    }

    return { ok: true };
  });
