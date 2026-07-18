// Server functions for per-label auto-assignment rules and the
// "apply rules to a contact" evaluator.
//
// Design: rules live in public.contact_group_rules (see migration
// 20260718*_contact_group_rules.sql). Matching is a pure function in
// ./group-rules.ts. This module wires the pure matcher to Supabase and
// contact_group_members / contact_group_suggestions.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  AI_CATEGORIES,
  collectEmailDomains,
  domainOfEmail,
  matchRules,
  type ContactSignals,
  type GroupRule,
} from "./group-rules";

type DB = SupabaseClient<Database>;

const RULE_TYPE = z.enum(["domain", "company_id", "ai_category"]);

// ─── Rule CRUD ──────────────────────────────────────────────────────

export const listGroupRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { groupId: string }) =>
    z.object({ groupId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("contact_group_rules")
      .select("id,group_id,rule_type,value,auto_apply,created_at")
      .eq("group_id", data.groupId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return { rules: rows ?? [] };
  });

export const addGroupRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        groupId: z.string().uuid(),
        ruleType: RULE_TYPE,
        value: z.string().trim().min(1).max(200),
        autoApply: z.boolean().default(true),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    let value = data.value.trim();
    if (data.ruleType === "domain") {
      value = value.toLowerCase().replace(/^@/, "");
    } else if (data.ruleType === "ai_category") {
      value = value.toLowerCase();
      if (!(AI_CATEGORIES as readonly string[]).includes(value)) {
        throw new Error("Unknown AI category");
      }
    }
    const { data: row, error } = await supabase
      .from("contact_group_rules")
      .upsert(
        {
          user_id: userId,
          group_id: data.groupId,
          rule_type: data.ruleType,
          value,
          auto_apply: data.autoApply,
        },
        { onConflict: "group_id,rule_type,value" },
      )
      .select("id,group_id,rule_type,value,auto_apply,created_at")
      .single();
    if (error) throw new Error(error.message);
    return { rule: row };
  });

export const updateGroupRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        autoApply: z.boolean().optional(),
        value: z.string().trim().min(1).max(200).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const patch: Record<string, unknown> = {};
    if (data.autoApply !== undefined) patch.auto_apply = data.autoApply;
    if (data.value !== undefined) patch.value = data.value;
    const { error } = await supabase
      .from("contact_group_rules")
      .update(patch)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteGroupRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("contact_group_rules")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ─── Rule evaluation ────────────────────────────────────────────────

/**
 * Load the signals for a single contact — company_id, ai_category, and
 * every associated email domain (primary + contact_emails rows).
 */
export async function loadContactSignals(
  supabase: DB,
  userId: string,
  contactId: string,
): Promise<ContactSignals | null> {
  const { data: c } = await supabase
    .from("contacts")
    .select("id,company_id,ai_category,email")
    .eq("user_id", userId)
    .eq("id", contactId)
    .maybeSingle();
  if (!c) return null;
  const { data: extra } = await supabase
    .from("contact_emails")
    .select("address")
    .eq("contact_id", contactId);
  const domains = collectEmailDomains([
    { address: c.email },
    ...((extra ?? []) as Array<{ address: string | null }>),
  ]);
  return {
    companyId: (c as { company_id: string | null }).company_id ?? null,
    aiCategory: (c as { ai_category: string | null }).ai_category ?? null,
    emailDomains: domains,
  };
}

async function loadUserRules(supabase: DB, userId: string): Promise<GroupRule[]> {
  const { data, error } = await supabase
    .from("contact_group_rules")
    .select("id,group_id,rule_type,value,auto_apply")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  return (data ?? []) as GroupRule[];
}

/**
 * Evaluate rules for a contact and act on matches. Auto-apply matches
 * insert into contact_group_members; suggest-only matches write to
 * contact_group_suggestions (reusing the existing table). Existing
 * memberships are respected — this never removes.
 */
export async function applyRulesForContact(
  supabase: DB,
  userId: string,
  contactId: string,
): Promise<{ auto: number; suggested: number }> {
  const signals = await loadContactSignals(supabase, userId, contactId);
  if (!signals) return { auto: 0, suggested: 0 };
  const rules = await loadUserRules(supabase, userId);
  if (rules.length === 0) return { auto: 0, suggested: 0 };
  const matches = matchRules(signals, rules);
  if (matches.length === 0) return { auto: 0, suggested: 0 };

  const autoGroupIds = [...new Set(matches.filter((m) => m.autoApply).map((m) => m.groupId))];
  const suggestGroupIds = [
    ...new Set(matches.filter((m) => !m.autoApply).map((m) => m.groupId)),
  ];

  let auto = 0;
  if (autoGroupIds.length > 0) {
    const rows = autoGroupIds.map((group_id) => ({
      user_id: userId,
      group_id,
      contact_id: contactId,
    }));
    const { error, count } = await supabase
      .from("contact_group_members")
      .upsert(rows, { onConflict: "group_id,contact_id", ignoreDuplicates: true, count: "exact" });
    if (error) throw new Error(error.message);
    auto = count ?? autoGroupIds.length;
  }

  let suggested = 0;
  if (suggestGroupIds.length > 0) {
    // Skip any group the contact is already a member of.
    const { data: existing } = await supabase
      .from("contact_group_members")
      .select("group_id")
      .eq("contact_id", contactId)
      .in("group_id", suggestGroupIds);
    const skip = new Set((existing ?? []).map((r) => r.group_id));
    const runId = crypto.randomUUID();
    const rows = suggestGroupIds
      .filter((gid) => !skip.has(gid))
      .map((gid) => {
        const match = matches.find((m) => m.groupId === gid);
        return {
          user_id: userId,
          run_id: runId,
          name: "auto-rule",
          existing_group_id: gid,
          contact_ids: [contactId],
          rationale: match ? `Matched ${match.ruleType}: ${match.reason}` : null,
          kind: "merge_into_existing",
          status: "pending",
        };
      });
    if (rows.length > 0) {
      const { error } = await supabase.from("contact_group_suggestions").insert(rows);
      if (error) throw new Error(error.message);
      suggested = rows.length;
    }
  }
  return { auto, suggested };
}

/** Server-fn wrapper called from the contact edit path. */
export const applyRulesForContactFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { contactId: string }) =>
    z.object({ contactId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    return applyRulesForContact(supabase, userId, data.contactId);
  });

/**
 * Preview which labels a contact would join if saved with the given
 * signals — used by the contact form to render suggestion chips before
 * the row is created. Does not write anything.
 */
export const suggestGroupsForContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        email: z.string().trim().email().optional().nullable(),
        additionalEmails: z.array(z.string().trim().email()).max(20).optional(),
        companyId: z.string().uuid().optional().nullable(),
        companyText: z.string().trim().max(200).optional().nullable(),
        aiCategory: z.string().trim().max(60).optional().nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Resolve companyText → existing company id (does NOT create).
    let companyId = data.companyId ?? null;
    let companyName: string | null = null;
    if (!companyId && data.companyText) {
      const { normalizeCompanyName } = await import("./company-name");
      const key = normalizeCompanyName(data.companyText);
      if (key) {
        const { data: co } = await supabase
          .from("companies")
          .select("id,name")
          .eq("user_id", userId)
          .eq("name_key", key)
          .maybeSingle();
        if (co) {
          companyId = co.id;
          companyName = co.name;
        }
      }
    }
    const emails = [data.email ?? null, ...(data.additionalEmails ?? []).map((e) => e)];
    const domains = collectEmailDomains(emails.map((address) => ({ address })));
    const signals: ContactSignals = {
      companyId,
      aiCategory: data.aiCategory ?? null,
      emailDomains: domains,
    };
    const rules = await loadUserRules(supabase, userId);
    const matches = matchRules(signals, rules);
    const groupIds = [...new Set(matches.map((m) => m.groupId))];
    const { data: groups } = groupIds.length
      ? await supabase
          .from("contact_groups")
          .select("id,name,color,parent_group_id")
          .in("id", groupIds)
      : { data: [] };
    const groupsById = new Map((groups ?? []).map((g) => [g.id, g] as const));

    // Also surface close name matches: any existing label whose normalized
    // name matches the companyText, so the user attaches to an existing
    // label instead of creating a new one.
    let closeName: { id: string; name: string } | null = null;
    if (data.companyText) {
      const { normalizeCompanyName } = await import("./company-name");
      const key = normalizeCompanyName(data.companyText);
      if (key) {
        const { data: allGroups } = await supabase
          .from("contact_groups")
          .select("id,name")
          .eq("user_id", userId);
        for (const g of allGroups ?? []) {
          if (normalizeCompanyName(g.name) === key) {
            closeName = { id: g.id, name: g.name };
            break;
          }
        }
      }
    }

    return {
      companyResolved: companyId ? { id: companyId, name: companyName } : null,
      matches: matches.map((m) => {
        const g = groupsById.get(m.groupId);
        return {
          ruleId: m.ruleId,
          groupId: m.groupId,
          groupName: g?.name ?? "(deleted)",
          groupColor: g?.color ?? null,
          reason: m.reason,
          ruleType: m.ruleType,
          autoApply: m.autoApply,
        };
      }),
      closeNameMatch: closeName,
      aiCategories: AI_CATEGORIES,
    };
  });

// ─── Backfill ───────────────────────────────────────────────────────

/** Re-evaluate every contact against current rules. Bulk, one-shot. */
export const applyGroupRulesToAllContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: ids, error } = await supabase
      .from("contacts")
      .select("id")
      .eq("user_id", userId)
      .limit(20000);
    if (error) throw new Error(error.message);
    let auto = 0;
    let suggested = 0;
    for (const row of ids ?? []) {
      const r = await applyRulesForContact(supabase, userId, row.id);
      auto += r.auto;
      suggested += r.suggested;
    }
    return { scanned: (ids ?? []).length, auto, suggested };
  });
