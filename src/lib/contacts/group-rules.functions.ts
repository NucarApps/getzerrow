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
import { pairKey, planRuleMembershipSync } from "./company-label-sync";
import { reconcileIfAuto } from "./auto-company-subgroups.functions";
import { bumpResyncNonce } from "@/lib/carddav/settings.functions";

type DB = SupabaseClient<Database>;

const RULE_TYPE = z.enum(["domain", "company_id", "ai_category"]);

// ─── Membership sync engine ─────────────────────────────────────────
//
// Materializes rule-derived memberships (source='rule') and keeps them in
// sync: contacts gain labels their rules justify and lose rule rows no rule
// justifies anymore ("company is in label" semantics — new hires inherit,
// leavers drop). Only touches source='rule' rows; see company-label-sync.ts.

const CHUNK = 500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function syncCompanyRuleMemberships(
  supabase: DB,
  userId: string,
  opts: {
    /** Narrow scope: all contacts linked to these companies. */
    companyIds?: string[];
    /** Narrow scope: exactly these contacts. */
    contactIds?: string[];
    /** Broad scope: rules changed for these groups — scans all contacts. */
    groupIds?: string[];
    /** Re-evaluate every contact. */
    full?: boolean;
    /** Bump the CardDAV resync nonce when memberships changed (bulk ops). */
    bumpResync?: boolean;
  },
): Promise<{ scanned: number; added: number; removed: number }> {
  const rules = await loadUserRules(supabase, userId);

  // Resolve the contact scope. Group-scoped changes (rule added/removed)
  // need a full scan to find NEW matches; company/contact scopes stay narrow.
  const scanAll = !!opts.full || (opts.groupIds?.length ?? 0) > 0;
  const scopeIds = new Set<string>(opts.contactIds ?? []);
  if (!scanAll && (opts.companyIds?.length ?? 0) > 0) {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .eq("user_id", userId)
      .in("company_id", opts.companyIds!);
    for (const r of data ?? []) scopeIds.add(r.id);
    // Contacts that LEFT these companies still hold rule rows in the
    // companies' labels — include current rule-row holders of those labels.
    const ruleGroupIds = rules
      .filter((r) => r.rule_type === "company_id" && opts.companyIds!.includes(r.value))
      .map((r) => r.group_id);
    if (ruleGroupIds.length > 0) {
      const { data: holders } = await supabase
        .from("contact_group_members")
        .select("contact_id")
        .eq("user_id", userId)
        .eq("source", "rule")
        .in("group_id", ruleGroupIds);
      for (const r of holders ?? []) scopeIds.add(r.contact_id);
    }
  }

  // Load signals in bulk.
  let contactRows: Array<{
    id: string;
    company_id: string | null;
    ai_category: string | null;
    email: string | null;
  }> = [];
  if (scanAll) {
    const { data, error } = await supabase
      .from("contacts")
      .select("id,company_id,ai_category,email")
      .eq("user_id", userId)
      .limit(20000);
    if (error) throw new Error(error.message);
    contactRows = (data ?? []) as typeof contactRows;
  } else {
    if (scopeIds.size === 0) return { scanned: 0, added: 0, removed: 0 };
    for (const ids of chunk([...scopeIds], CHUNK)) {
      const { data, error } = await supabase
        .from("contacts")
        .select("id,company_id,ai_category,email")
        .eq("user_id", userId)
        .in("id", ids);
      if (error) throw new Error(error.message);
      contactRows.push(...((data ?? []) as typeof contactRows));
    }
  }
  const contactIds = contactRows.map((c) => c.id);

  const emailsByContact = new Map<string, Array<{ address: string | null }>>();
  if (scanAll) {
    const { data } = await supabase
      .from("contact_emails")
      .select("contact_id,address")
      .eq("user_id", userId);
    for (const r of (data ?? []) as Array<{ contact_id: string; address: string | null }>) {
      const arr = emailsByContact.get(r.contact_id) ?? [];
      arr.push({ address: r.address });
      emailsByContact.set(r.contact_id, arr);
    }
  } else {
    for (const ids of chunk(contactIds, CHUNK)) {
      const { data } = await supabase
        .from("contact_emails")
        .select("contact_id,address")
        .in("contact_id", ids);
      for (const r of (data ?? []) as Array<{ contact_id: string; address: string | null }>) {
        const arr = emailsByContact.get(r.contact_id) ?? [];
        arr.push({ address: r.address });
        emailsByContact.set(r.contact_id, arr);
      }
    }
  }

  const signalsByContact = new Map<string, ContactSignals>();
  for (const c of contactRows) {
    signalsByContact.set(c.id, {
      companyId: c.company_id ?? null,
      aiCategory: c.ai_category ?? null,
      emailDomains: collectEmailDomains([
        { address: c.email },
        ...(emailsByContact.get(c.id) ?? []),
      ]),
    });
  }

  // Existing memberships for the scope (any source) + current rule rows.
  const existingMemberPairs = new Set<string>();
  const currentRuleRows: Array<{ group_id: string; contact_id: string }> = [];
  for (const ids of chunk(contactIds, CHUNK)) {
    const { data } = await supabase
      .from("contact_group_members")
      .select("group_id,contact_id,source")
      .eq("user_id", userId)
      .in("contact_id", ids);
    for (const r of (data ?? []) as Array<{
      group_id: string;
      contact_id: string;
      source: string | null;
    }>) {
      existingMemberPairs.add(pairKey(r.group_id, r.contact_id));
      if (r.source === "rule") {
        currentRuleRows.push({ group_id: r.group_id, contact_id: r.contact_id });
      }
    }
  }

  const plan = planRuleMembershipSync({
    rules,
    signalsByContact,
    currentRuleRows,
    existingMemberPairs,
  });

  for (const rows of chunk(plan.toAdd, CHUNK)) {
    const { error } = await supabase.from("contact_group_members").upsert(
      rows.map((p) => ({
        user_id: userId,
        group_id: p.group_id,
        contact_id: p.contact_id,
        auto_added: true,
        source: "rule",
      })),
      { onConflict: "group_id,contact_id", ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);
  }
  const removeByGroup = new Map<string, string[]>();
  for (const p of plan.toRemove) {
    const arr = removeByGroup.get(p.group_id) ?? [];
    arr.push(p.contact_id);
    removeByGroup.set(p.group_id, arr);
  }
  for (const [groupId, cids] of removeByGroup) {
    for (const ids of chunk(cids, CHUNK)) {
      const { error } = await supabase
        .from("contact_group_members")
        .delete()
        .eq("user_id", userId)
        .eq("group_id", groupId)
        .eq("source", "rule")
        .in("contact_id", ids);
      if (error) throw new Error(error.message);
    }
  }

  // Let the auto-subgroup reconciler settle any touched auto-parents, and
  // nudge iPhones when bulk changes happened.
  const touchedGroups = new Set<string>([
    ...plan.toAdd.map((p) => p.group_id),
    ...plan.toRemove.map((p) => p.group_id),
  ]);
  for (const gid of touchedGroups) {
    await reconcileIfAuto(supabase, userId, gid);
  }
  if (opts.bumpResync && (plan.toAdd.length > 0 || plan.toRemove.length > 0)) {
    try {
      await bumpResyncNonce(supabase, userId);
    } catch {
      // Non-fatal.
    }
  }

  return { scanned: contactRows.length, added: plan.toAdd.length, removed: plan.toRemove.length };
}

// ─── Rule CRUD ──────────────────────────────────────────────────────

export const listGroupRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { groupId: string }) => z.object({ groupId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: rows, error } = await supabase
      .from("contact_group_rules")
      .select("id,group_id,rule_type,value,auto_apply,created_at")
      .eq("group_id", data.groupId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    // Resolve company_id values to names so the UI shows "Nissan", not a UUID.
    const companyIds = (rows ?? []).filter((r) => r.rule_type === "company_id").map((r) => r.value);
    const nameById = new Map<string, string>();
    if (companyIds.length > 0) {
      const { data: companies } = await supabase
        .from("companies")
        .select("id,name")
        .eq("user_id", userId)
        .in("id", companyIds);
      for (const c of companies ?? []) nameById.set(c.id, c.name);
    }
    return {
      rules: (rows ?? []).map((r) => ({
        ...r,
        display: r.rule_type === "company_id" ? (nameById.get(r.value) ?? r.value) : r.value,
      })),
    };
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
    } else if (data.ruleType === "company_id") {
      const { data: co } = await supabase
        .from("companies")
        .select("id")
        .eq("user_id", userId)
        .eq("id", value)
        .maybeSingle();
      if (!co) throw new Error("Company not found");
    }
    // Auto-generated subgroups are reconciler-managed — no direct rules.
    const { data: g } = await supabase
      .from("contact_groups")
      .select("auto_generated_from_group_id")
      .eq("id", data.groupId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!g) throw new Error("Label not found");
    if (g.auto_generated_from_group_id) {
      throw new Error("This subgroup is managed automatically from its parent");
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
    // Backfill: materialize memberships the new rule justifies.
    if (data.autoApply) {
      await syncCompanyRuleMemberships(supabase, userId, {
        ...(data.ruleType === "company_id"
          ? { companyIds: [value] }
          : { groupIds: [data.groupId] }),
        bumpResync: true,
      });
    }
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
    const { supabase, userId } = context;
    const patch: { auto_apply?: boolean; value?: string } = {};
    if (data.autoApply !== undefined) patch.auto_apply = data.autoApply;
    if (data.value !== undefined) patch.value = data.value;
    const { data: row, error } = await supabase
      .from("contact_group_rules")
      .update(patch)
      .eq("id", data.id)
      .select("group_id,rule_type,value,auto_apply")
      .maybeSingle();
    if (error) throw new Error(error.message);
    // Re-sync: an autoApply flip or value change adds/removes materialized rows.
    if (row) {
      await syncCompanyRuleMemberships(supabase, userId, {
        groupIds: [row.group_id],
        bumpResync: true,
      });
    }
    return { ok: true };
  });

export const deleteGroupRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row } = await supabase
      .from("contact_group_rules")
      .select("group_id")
      .eq("id", data.id)
      .maybeSingle();
    const { error } = await supabase.from("contact_group_rules").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    // Cleanup: remove now-unjustified materialized rows. Scope to the
    // group's current rule-row holders — cheaper than a full scan.
    if (row) {
      const { data: holders } = await supabase
        .from("contact_group_members")
        .select("contact_id")
        .eq("user_id", userId)
        .eq("group_id", row.group_id)
        .eq("source", "rule");
      const contactIds = (holders ?? []).map((h) => h.contact_id);
      if (contactIds.length > 0) {
        await syncCompanyRuleMemberships(supabase, userId, { contactIds, bumpResync: true });
      }
    }
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
 * materialize as source='rule' membership rows; rule rows no longer
 * justified by any auto rule are removed (a contact who leaves a company
 * drops out of that company's labels). Manual and reconciler-owned rows
 * are never touched. Suggest-only matches write to
 * contact_group_suggestions (reusing the existing table).
 */
export async function applyRulesForContact(
  supabase: DB,
  userId: string,
  contactId: string,
): Promise<{ auto: number; suggested: number }> {
  const signals = await loadContactSignals(supabase, userId, contactId);
  if (!signals) return { auto: 0, suggested: 0 };
  const rules = await loadUserRules(supabase, userId);
  const matches = rules.length > 0 ? matchRules(signals, rules) : [];

  const autoGroupIds = [...new Set(matches.filter((m) => m.autoApply).map((m) => m.groupId))];
  const suggestGroupIds = [...new Set(matches.filter((m) => !m.autoApply).map((m) => m.groupId))];

  let auto = 0;
  if (autoGroupIds.length > 0) {
    const rows = autoGroupIds.map((group_id) => ({
      user_id: userId,
      group_id,
      contact_id: contactId,
      auto_added: true,
      source: "rule",
    }));
    const { error, count } = await supabase
      .from("contact_group_members")
      .upsert(rows, { onConflict: "group_id,contact_id", ignoreDuplicates: true, count: "exact" });
    if (error) throw new Error(error.message);
    auto = count ?? autoGroupIds.length;
  }

  // Drop rule rows no auto rule justifies anymore.
  {
    const q = supabase
      .from("contact_group_members")
      .delete()
      .eq("user_id", userId)
      .eq("contact_id", contactId)
      .eq("source", "rule");
    const { error } =
      autoGroupIds.length > 0
        ? await q.not("group_id", "in", `(${autoGroupIds.join(",")})`)
        : await q;
    if (error) throw new Error(error.message);
  }
  if (matches.length === 0) return { auto, suggested: 0 };

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
  .inputValidator((d: { contactId: string }) => z.object({ contactId: z.string().uuid() }).parse(d))
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
    const r = await syncCompanyRuleMemberships(supabase, userId, {
      full: true,
      bumpResync: true,
    });
    return { scanned: r.scanned, auto: r.added, suggested: 0, removed: r.removed };
  });
