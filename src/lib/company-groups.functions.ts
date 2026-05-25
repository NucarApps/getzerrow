import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const DOMAIN = z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i);

/** List all company-level group assignments for the current user. */
export const listCompanyGroupAssignments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("company_group_assignments")
      .select("primary_domain,group_id");
    if (error) throw new Error(error.message);
    return (data ?? []) as { primary_domain: string; group_id: string }[];
  });

/**
 * Save the set of groups attached to a company (by primary domain), and
 * materialize the selected groups onto every contact in `contactIds`.
 * Does not remove memberships when a group is deselected — keeps existing
 * per-contact tags safe.
 */
export const setCompanyGroups = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { primaryDomain: string; contactIds: string[]; groupIds: string[] }) =>
    z.object({
      primaryDomain: DOMAIN,
      contactIds: z.array(z.string().uuid()).max(5000),
      groupIds: z.array(z.string().uuid()).max(50),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const domain = data.primaryDomain.toLowerCase();

    // Sync company_group_assignments to exactly match the selection.
    const { data: existing, error: exErr } = await supabase
      .from("company_group_assignments")
      .select("group_id")
      .eq("primary_domain", domain);
    if (exErr) throw new Error(exErr.message);

    const existingIds = new Set((existing ?? []).map((r) => r.group_id));
    const desired = new Set(data.groupIds);

    const toDelete = [...existingIds].filter((g) => !desired.has(g));
    const toInsert = [...desired].filter((g) => !existingIds.has(g));

    if (toDelete.length > 0) {
      const { error } = await supabase
        .from("company_group_assignments")
        .delete()
        .eq("primary_domain", domain)
        .in("group_id", toDelete);
      if (error) throw new Error(error.message);
    }
    if (toInsert.length > 0) {
      const rows = toInsert.map((group_id) => ({
        user_id: userId, primary_domain: domain, group_id,
      }));
      const { error } = await supabase.from("company_group_assignments").insert(rows);
      if (error) throw new Error(error.message);
    }

    // Materialize memberships for every contact in the bucket.
    let tagged = 0;
    if (data.contactIds.length > 0 && data.groupIds.length > 0) {
      const rows = data.contactIds.flatMap((contact_id) =>
        data.groupIds.map((group_id) => ({ user_id: userId, group_id, contact_id }))
      );
      const { error } = await supabase
        .from("contact_group_members")
        .upsert(rows, { onConflict: "group_id,contact_id", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
      tagged = data.contactIds.length;
    }

    return { ok: true, tagged };
  });
