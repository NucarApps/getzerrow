// Company ↔ label linkage, backed by contact_group_rules
// (rule_type='company_id'). Putting a company in a label materializes the
// label onto every contact of that company and keeps it in sync as people
// join/leave — see syncCompanyRuleMemberships. Replaces the legacy
// company_group_assignments table (one-shot tagging by primary domain),
// whose rows were migrated to rules; the table no longer receives writes.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { syncCompanyRuleMemberships } from "@/lib/contacts/group-rules.functions";

/** Labels a company belongs to (its company_id rules). */
export const listCompanyLabels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { companyId: string }) => z.object({ companyId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: rows, error } = await supabase
      .from("contact_group_rules")
      .select("group_id, auto_apply")
      .eq("user_id", userId)
      .eq("rule_type", "company_id")
      .eq("value", data.companyId);
    if (error) throw new Error(error.message);
    return {
      groupIds: (rows ?? []).filter((r) => r.auto_apply).map((r) => r.group_id),
    };
  });

/** Replace the set of labels a company belongs to. Adds/removes company_id
 *  rules and syncs the materialized memberships (contacts of the company
 *  gain/lose the labels; manual memberships are never touched). */
export const setCompanyLabels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { companyId: string; groupIds: string[] }) =>
    z
      .object({
        companyId: z.string().uuid(),
        groupIds: z.array(z.string().uuid()).max(50),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: company } = await supabase
      .from("companies")
      .select("id")
      .eq("user_id", userId)
      .eq("id", data.companyId)
      .maybeSingle();
    if (!company) throw new Error("Company not found");

    const { data: current, error: curErr } = await supabase
      .from("contact_group_rules")
      .select("id, group_id")
      .eq("user_id", userId)
      .eq("rule_type", "company_id")
      .eq("value", data.companyId);
    if (curErr) throw new Error(curErr.message);

    const currentByGroup = new Map((current ?? []).map((r) => [r.group_id, r.id]));
    const desired = new Set(data.groupIds);

    // Auto-generated subgroups are reconciler-managed — silently skip them.
    const { data: groups } = await supabase
      .from("contact_groups")
      .select("id, auto_generated_from_group_id")
      .eq("user_id", userId)
      .in("id", [...desired]);
    const addable = new Set(
      (groups ?? []).filter((g) => !g.auto_generated_from_group_id).map((g) => g.id),
    );

    const toAdd = [...desired].filter((g) => addable.has(g) && !currentByGroup.has(g));
    const toRemove = [...currentByGroup.keys()].filter((g) => !desired.has(g));

    if (toAdd.length > 0) {
      const { error } = await supabase.from("contact_group_rules").upsert(
        toAdd.map((group_id) => ({
          user_id: userId,
          group_id,
          rule_type: "company_id",
          value: data.companyId,
          auto_apply: true,
        })),
        { onConflict: "group_id,rule_type,value" },
      );
      if (error) throw new Error(error.message);
    }
    if (toRemove.length > 0) {
      const ids = toRemove.map((g) => currentByGroup.get(g)).filter((v): v is string => !!v);
      const { error } = await supabase.from("contact_group_rules").delete().in("id", ids);
      if (error) throw new Error(error.message);
    }

    // Keep companies.linked_group_id — THE label that represents this
    // company (used by the shared label resolver to short-circuit) — in
    // sync with the selection: keep the current link while still selected,
    // else adopt the first selected label, else clear.
    const { data: linkRow } = await supabase
      .from("companies")
      .select("linked_group_id")
      .eq("id", data.companyId)
      .eq("user_id", userId)
      .maybeSingle();
    const currentLinked =
      (linkRow as { linked_group_id: string | null } | null)?.linked_group_id ?? null;
    const nextLinked =
      currentLinked && desired.has(currentLinked)
        ? currentLinked
        : ([...desired].find((g) => addable.has(g)) ?? null);
    if (nextLinked !== currentLinked) {
      await supabase
        .from("companies")
        .update({ linked_group_id: nextLinked })
        .eq("id", data.companyId)
        .eq("user_id", userId);
    }

    const changed = toAdd.length > 0 || toRemove.length > 0;
    let synced = { scanned: 0, added: 0, removed: 0 };
    if (changed) {
      synced = await syncCompanyRuleMemberships(supabase, userId, {
        companyIds: [data.companyId],
        bumpResync: true,
      });
    }
    return {
      ok: true,
      rulesAdded: toAdd.length,
      rulesRemoved: toRemove.length,
      scanned: synced.scanned,
      added: synced.added,
      removed: synced.removed,
    };
  });
