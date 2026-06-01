import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** List the user's groups with member counts. */
export const listContactGroups = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const [{ data: groups, error: gErr }, { data: members, error: mErr }] = await Promise.all([
      supabase
        .from("contact_groups")
        .select("id,name,color,created_at")
        .order("name", { ascending: true }),
      supabase.from("contact_group_members").select("group_id,contact_id"),
    ]);
    if (gErr) throw new Error(gErr.message);
    if (mErr) throw new Error(mErr.message);

    const counts = new Map<string, number>();
    for (const m of members ?? []) counts.set(m.group_id, (counts.get(m.group_id) ?? 0) + 1);

    return {
      groups: (groups ?? []).map((g) => ({ ...g, count: counts.get(g.id) ?? 0 })),
      memberships: (members ?? []) as { group_id: string; contact_id: string }[],
    };
  });

export const createContactGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { name: string; color?: string }) =>
    z.object({ name: z.string().min(1).max(60), color: COLOR.optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("contact_groups")
      .insert({ user_id: userId, name: data.name.trim(), color: data.color ?? "#6366f1" })
      .select("id,name,color,created_at")
      .single();
    if (error) throw new Error(error.message);
    return { group: row };
  });

export const updateContactGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; name?: string; color?: string }) =>
    z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1).max(60).optional(),
        color: COLOR.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { id, ...patch } = data;
    const { data: row, error } = await supabase
      .from("contact_groups")
      .update(patch)
      .eq("id", id)
      .select("id,name,color,created_at")
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
    }
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
