// Label auto-assignment rules (group-rules.functions.ts). Contracts
// protected:
//
//   * addGroupRule normalizes a domain rule (leading "@" stripped,
//     lowercased) and refuses an unknown ai_category, a foreign company id,
//     a foreign label, and a reconciler-managed subgroup — each with zero
//     writes,
//   * updateGroupRule / deleteGroupRule scope by (id, user_id) and report
//     "Rule not found" for another tenant's rule, leaving it unchanged,
//   * applyRulesForContact splits auto-apply matches (materialized
//     source='rule' memberships) from suggest-only matches (rows in
//     contact_group_suggestions) and drops rule rows no rule justifies,
//   * syncCompanyRuleMemberships only ever materializes memberships for the
//     caller's own contacts, and its writes carry the caller's user_id.
//
// The rules module runs on the user-scoped `context.supabase` client but
// filters explicitly on user_id at every rule/company/label read, so the
// cross-tenant assertions below are real (the fake enforces the predicate)
// rather than RLS-reliant.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";
import { makeContactRow, makeGroupRow } from "./__fixtures__/rows";

const rls = makeSupabaseFake({ applyWrites: true });

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

const reconcileIfAuto = vi.fn(async () => {});
vi.mock("./auto-company-subgroups.functions", () => ({
  reconcileIfAuto: (...a: unknown[]) => reconcileIfAuto(...(a as [])),
}));

const bumpResyncNonce = vi.fn(async () => {});
vi.mock("@/lib/carddav/settings.functions", () => ({
  bumpResyncNonce: (...a: unknown[]) => bumpResyncNonce(...(a as [])),
}));

import {
  addGroupRule,
  updateGroupRule,
  deleteGroupRule,
  listGroupRules,
  applyGroupRulesToAllContacts,
  applyRulesForContact,
  loadContactSignals,
  syncCompanyRuleMemberships,
} from "./group-rules.functions";
import type { DB } from "@/lib/supabase-db";

const GROUP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RULE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COMPANY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONTACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VICTIM = "victim-user-2";
const ATTACKER = "attacker-user-9";

type CallArgs = { data?: unknown; context?: Record<string, unknown> };
function call(fn: unknown, args: CallArgs): Promise<never> {
  return (fn as (a: CallArgs) => Promise<never>)(args);
}
const asUser = { supabase: rls.supabaseAdmin };
const asAttacker = { supabase: rls.supabaseAdmin, userId: ATTACKER };
/** The fake under the `DB` type the exported helpers declare. */
const db = rls.supabaseAdmin as unknown as DB;

beforeEach(() => {
  rls.reset();
  reconcileIfAuto.mockClear();
  bumpResyncNonce.mockClear();
});

describe("addGroupRule", () => {
  beforeEach(() => {
    rls.seed("contact_groups", [makeGroupRow({ id: GROUP_ID, user_id: TEST_USER })]);
  });

  it("normalizes a domain rule: leading @ stripped and lowercased", async () => {
    await call(addGroupRule, {
      data: { groupId: GROUP_ID, ruleType: "domain", value: "@ACME.com" },
      context: asUser,
    });
    const up = rls.calls.upserts.find((u) => u.table === "contact_group_rules")!;
    expect(up.payload).toStrictEqual({
      user_id: TEST_USER,
      group_id: GROUP_ID,
      rule_type: "domain",
      value: "acme.com",
      auto_apply: true,
    });
    expect(up.options).toStrictEqual({ onConflict: "group_id,rule_type,value" });
  });

  it("rejects an ai_category outside the known list without writing", async () => {
    await expect(
      call(addGroupRule, {
        data: { groupId: GROUP_ID, ruleType: "ai_category", value: "astrology" },
        context: asUser,
      }),
    ).rejects.toThrow("Unknown AI category");
    expect(writeCount(rls)).toBe(0);
  });

  it("accepts a known ai_category, lowercased", async () => {
    await call(addGroupRule, {
      data: { groupId: GROUP_ID, ruleType: "ai_category", value: "Automotive" },
      context: asUser,
    });
    expect(rls.calls.upserts[0]!.payload).toMatchObject({
      rule_type: "ai_category",
      value: "automotive",
    });
  });

  it("another tenant's label is not found, and nothing is written", async () => {
    rls.seed("contact_groups", [makeGroupRow({ id: GROUP_ID, user_id: VICTIM })]);
    await expectDeniedCrossUser({
      fake: rls,
      rejects: "Label not found",
      call: () =>
        call(addGroupRule, {
          data: { groupId: GROUP_ID, ruleType: "domain", value: "acme.com" },
          context: asAttacker,
        }),
    });
  });

  it("another tenant's company id is not found, and nothing is written", async () => {
    rls.seed("companies", [{ id: COMPANY_ID, user_id: VICTIM, name: "Victim Co" }]);
    await expectDeniedCrossUser({
      fake: rls,
      rejects: "Company not found",
      call: () =>
        call(addGroupRule, {
          data: { groupId: GROUP_ID, ruleType: "company_id", value: COMPANY_ID },
          context: asAttacker,
        }),
    });
  });

  it("refuses to attach a rule to a reconciler-managed auto subgroup", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({
        id: GROUP_ID,
        user_id: TEST_USER,
        auto_generated_from_group_id: "parent-group",
      }),
    ]);
    await expect(
      call(addGroupRule, {
        data: { groupId: GROUP_ID, ruleType: "domain", value: "acme.com" },
        context: asUser,
      }),
    ).rejects.toThrow("managed automatically");
    expect(writeCount(rls)).toBe(0);
  });

  it("a failing upsert surfaces and skips the membership backfill", async () => {
    rls.onUpsert("contact_group_rules", () => ({ message: "duplicate key value" }));
    await expect(
      call(addGroupRule, {
        data: { groupId: GROUP_ID, ruleType: "domain", value: "acme.com" },
        context: asUser,
      }),
    ).rejects.toThrow("duplicate key value");
    expect(rls.calls.upserts.filter((u) => u.table === "contact_group_members")).toHaveLength(0);
  });

  it("autoApply=false stores the rule but materializes no memberships", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, email: "x@acme.com" }),
    ]);
    await call(addGroupRule, {
      data: { groupId: GROUP_ID, ruleType: "domain", value: "acme.com", autoApply: false },
      context: asUser,
    });
    expect(rls.calls.upserts.filter((u) => u.table === "contact_group_members")).toHaveLength(0);
  });
});

describe("updateGroupRule", () => {
  it("another tenant's rule reports Rule not found and stays untouched", async () => {
    rls.seed("contact_group_rules", [
      {
        id: RULE_ID,
        user_id: VICTIM,
        group_id: GROUP_ID,
        rule_type: "domain",
        value: "victim.com",
        auto_apply: true,
      },
    ]);
    await expect(
      call(updateGroupRule, {
        data: { id: RULE_ID, value: "attacker.com", autoApply: false },
        context: asAttacker,
      }),
    ).rejects.toThrow("Rule not found");
    // The UPDATE is issued but carries the user_id predicate, so it matches
    // no row: the victim's rule is byte-for-byte unchanged.
    expect(rls.rows("contact_group_rules")[0]).toMatchObject({
      value: "victim.com",
      auto_apply: true,
      user_id: VICTIM,
    });
    const upd = rls.calls.updates.find((u) => u.table === "contact_group_rules")!;
    expect(upd.filters).toStrictEqual([
      { op: "eq", col: "id", value: RULE_ID, extra: undefined },
      { op: "eq", col: "user_id", value: ATTACKER, extra: undefined },
    ]);
  });

  it("patches only the supplied fields and re-syncs the rule's label", async () => {
    rls.seed("contact_group_rules", [
      {
        id: RULE_ID,
        user_id: TEST_USER,
        group_id: GROUP_ID,
        rule_type: "domain",
        value: "acme.com",
        auto_apply: true,
      },
    ]);
    const res = await call(updateGroupRule, {
      data: { id: RULE_ID, autoApply: false },
      context: asUser,
    });
    expect(res).toEqual({ ok: true });
    const upd = rls.calls.updates.find((u) => u.table === "contact_group_rules")!;
    expect(upd.payload).toStrictEqual({ auto_apply: false });
    expect(rls.rows("contact_group_rules")[0]).toMatchObject({
      value: "acme.com",
      auto_apply: false,
    });
  });

  it("a failing update surfaces to the caller", async () => {
    rls.onUpdate("contact_group_rules", () => ({ message: "value too long" }));
    await expect(
      call(updateGroupRule, { data: { id: RULE_ID, value: "x" }, context: asUser }),
    ).rejects.toThrow("value too long");
  });
});

describe("deleteGroupRule", () => {
  it("another tenant's rule is refused before any delete is issued", async () => {
    rls.seed("contact_group_rules", [
      {
        id: RULE_ID,
        user_id: VICTIM,
        group_id: GROUP_ID,
        rule_type: "domain",
        value: "victim.com",
        auto_apply: true,
      },
    ]);
    await expectDeniedCrossUser({
      fake: rls,
      rejects: "Rule not found",
      call: () => call(deleteGroupRule, { data: { id: RULE_ID }, context: asAttacker }),
    });
    expect(rls.rows("contact_group_rules")).toHaveLength(1);
  });

  it("deletes the caller's rule scoped by (id, user_id) and cleans up its rule rows", async () => {
    rls.seed("contact_group_rules", [
      {
        id: RULE_ID,
        user_id: TEST_USER,
        group_id: GROUP_ID,
        rule_type: "domain",
        value: "acme.com",
        auto_apply: true,
      },
    ]);
    rls.seed("contact_group_members", [
      {
        user_id: TEST_USER,
        group_id: GROUP_ID,
        contact_id: CONTACT_ID,
        source: "rule",
        auto_added: true,
      },
    ]);
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, email: "x@other.com" }),
    ]);

    const res = await call(deleteGroupRule, { data: { id: RULE_ID }, context: asUser });
    expect(res).toEqual({ ok: true });
    const del = rls.calls.deletes.find((d) => d.table === "contact_group_rules")!;
    expect(del.filters).toStrictEqual([
      { op: "eq", col: "id", value: RULE_ID, extra: undefined },
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
    ]);
    // The membership the deleted rule justified is gone too.
    expect(rls.rows("contact_group_members")).toHaveLength(0);
  });

  it("a failing delete surfaces to the caller", async () => {
    rls.seed("contact_group_rules", [
      {
        id: RULE_ID,
        user_id: TEST_USER,
        group_id: GROUP_ID,
        rule_type: "domain",
        value: "acme.com",
        auto_apply: true,
      },
    ]);
    rls.onDelete("contact_group_rules", () => ({ message: "foreign key violation" }));
    await expect(call(deleteGroupRule, { data: { id: RULE_ID }, context: asUser })).rejects.toThrow(
      "foreign key violation",
    );
  });
});

describe("listGroupRules", () => {
  it("resolves company_id rules to the company name for display", async () => {
    rls.seed("contact_group_rules", [
      {
        id: RULE_ID,
        user_id: TEST_USER,
        group_id: GROUP_ID,
        rule_type: "company_id",
        value: COMPANY_ID,
        auto_apply: true,
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);
    rls.seed("companies", [{ id: COMPANY_ID, user_id: TEST_USER, name: "Acme" }]);
    const res = (await call(listGroupRules, {
      data: { groupId: GROUP_ID },
      context: asUser,
    })) as unknown as { rules: Array<{ display: string }> };
    expect(res.rules.map((r) => r.display)).toStrictEqual(["Acme"]);
    // RLS-RELIANCE: the rules read filters by group_id only — a foreign
    // label id is stopped by the policy, not by this handler. The company
    // lookup that follows IS user_id-scoped.
    expect(rls.calls.selects[0]!.filters).toStrictEqual([
      { op: "eq", col: "group_id", value: GROUP_ID, extra: undefined },
    ]);
    expect(rls.calls.selects[1]!.filters).toContainEqual({
      op: "eq",
      col: "user_id",
      value: TEST_USER,
      extra: undefined,
    });
  });

  it("a failing read surfaces to the caller", async () => {
    rls.onSelect("contact_group_rules", () => ({ message: "statement timeout" }));
    await expect(
      call(listGroupRules, { data: { groupId: GROUP_ID }, context: asUser }),
    ).rejects.toThrow("statement timeout");
  });
});

describe("applyRulesForContact", () => {
  it("auto-apply matches materialize a source='rule' membership", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, email: "ada@acme.com" }),
    ]);
    rls.seed("contact_group_rules", [
      {
        id: RULE_ID,
        user_id: TEST_USER,
        group_id: GROUP_ID,
        rule_type: "domain",
        value: "acme.com",
        auto_apply: true,
      },
    ]);

    const res = await applyRulesForContact(db, TEST_USER, CONTACT_ID);
    expect(res).toStrictEqual({ auto: 1, suggested: 0 });
    const up = rls.calls.upserts.find((u) => u.table === "contact_group_members")!;
    expect(up.payload).toStrictEqual([
      {
        user_id: TEST_USER,
        group_id: GROUP_ID,
        contact_id: CONTACT_ID,
        auto_added: true,
        source: "rule",
      },
    ]);
    expect(up.options).toStrictEqual({
      onConflict: "group_id,contact_id",
      ignoreDuplicates: true,
      count: "exact",
    });
    expect(rls.calls.inserts.filter((i) => i.table === "contact_group_suggestions")).toHaveLength(
      0,
    );
  });

  it("a suggest-only match writes a pending suggestion instead of a membership", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, email: "ada@acme.com" }),
    ]);
    rls.seed("contact_group_rules", [
      {
        id: RULE_ID,
        user_id: TEST_USER,
        group_id: GROUP_ID,
        rule_type: "domain",
        value: "acme.com",
        auto_apply: false,
      },
    ]);

    const res = await applyRulesForContact(db, TEST_USER, CONTACT_ID);
    expect(res).toStrictEqual({ auto: 0, suggested: 1 });
    expect(rls.calls.upserts.filter((u) => u.table === "contact_group_members")).toHaveLength(0);
    const rows = rls.calls.inserts.find((i) => i.table === "contact_group_suggestions")!
      .payload as Array<Record<string, unknown>>;
    expect(rows).toStrictEqual([
      {
        user_id: TEST_USER,
        run_id: expect.any(String),
        name: "auto-rule",
        existing_group_id: GROUP_ID,
        contact_ids: [CONTACT_ID],
        rationale: "Matched domain: acme.com",
        kind: "merge_into_existing",
        status: "pending",
      },
    ]);
  });

  it("a contact belonging to another tenant matches nothing and writes nothing", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: VICTIM, email: "ada@acme.com" }),
    ]);
    rls.seed("contact_group_rules", [
      {
        id: RULE_ID,
        user_id: ATTACKER,
        group_id: GROUP_ID,
        rule_type: "domain",
        value: "acme.com",
        auto_apply: true,
      },
    ]);
    const res = await applyRulesForContact(db, ATTACKER, CONTACT_ID);
    expect(res).toStrictEqual({ auto: 0, suggested: 0 });
    expect(writeCount(rls)).toBe(0);
  });

  it("a failing membership upsert surfaces to the caller", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, email: "ada@acme.com" }),
    ]);
    rls.seed("contact_group_rules", [
      {
        id: RULE_ID,
        user_id: TEST_USER,
        group_id: GROUP_ID,
        rule_type: "domain",
        value: "acme.com",
        auto_apply: true,
      },
    ]);
    rls.onUpsert("contact_group_members", () => ({ message: "insert violates policy" }));
    await expect(applyRulesForContact(db, TEST_USER, CONTACT_ID)).rejects.toThrow(
      "insert violates policy",
    );
  });
});

describe("loadContactSignals", () => {
  it("returns null for a contact owned by another tenant", async () => {
    rls.seed("contacts", [makeContactRow({ id: CONTACT_ID, user_id: VICTIM })]);
    expect(await loadContactSignals(db, ATTACKER, CONTACT_ID)).toBeNull();
  });

  it("collects the primary and secondary email domains", async () => {
    rls.seed("contacts", [
      makeContactRow({
        id: CONTACT_ID,
        user_id: TEST_USER,
        email: "ada@Acme.com",
        company_id: COMPANY_ID,
        ai_category: "software",
      }),
    ]);
    rls.seed("contact_emails", [
      { id: "ce1", user_id: TEST_USER, contact_id: CONTACT_ID, address: "ada@side.io" },
    ]);
    expect(await loadContactSignals(db, TEST_USER, CONTACT_ID)).toStrictEqual({
      companyId: COMPANY_ID,
      aiCategory: "software",
      emailDomains: ["acme.com", "side.io"],
    });
  });
});

describe("syncCompanyRuleMemberships", () => {
  it("materializes memberships for the caller's contacts only", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: "mine", user_id: TEST_USER, email: "a@acme.com" }),
      makeContactRow({ id: "theirs", user_id: VICTIM, email: "b@acme.com" }),
    ]);
    rls.seed("contact_group_rules", [
      {
        id: RULE_ID,
        user_id: TEST_USER,
        group_id: GROUP_ID,
        rule_type: "domain",
        value: "acme.com",
        auto_apply: true,
      },
    ]);

    const res = await syncCompanyRuleMemberships(db, TEST_USER, { full: true, bumpResync: true });
    expect(res).toStrictEqual({ scanned: 1, added: 1, removed: 0 });
    const up = rls.calls.upserts.find((u) => u.table === "contact_group_members")!;
    expect(up.payload).toStrictEqual([
      {
        user_id: TEST_USER,
        group_id: GROUP_ID,
        contact_id: "mine",
        auto_added: true,
        source: "rule",
      },
    ]);
    expect(bumpResyncNonce).toHaveBeenCalledWith(rls.supabaseAdmin, TEST_USER);
    expect(reconcileIfAuto).toHaveBeenCalledWith(rls.supabaseAdmin, TEST_USER, GROUP_ID);
  });

  it("drops a rule row no rule justifies anymore", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: "mine", user_id: TEST_USER, email: "a@other.com" }),
    ]);
    rls.seed("contact_group_members", [
      {
        user_id: TEST_USER,
        group_id: GROUP_ID,
        contact_id: "mine",
        source: "rule",
        auto_added: true,
      },
    ]);
    const res = await syncCompanyRuleMemberships(db, TEST_USER, { full: true });
    expect(res).toStrictEqual({ scanned: 1, added: 0, removed: 1 });
    expect(rls.rows("contact_group_members")).toHaveLength(0);
    // No bumpResync opt-in → the CardDAV nonce is left alone.
    expect(bumpResyncNonce).not.toHaveBeenCalled();
  });

  it("a narrow scope with nothing in it does no work at all", async () => {
    const res = await syncCompanyRuleMemberships(db, TEST_USER, { contactIds: [] });
    expect(res).toStrictEqual({ scanned: 0, added: 0, removed: 0 });
    expect(writeCount(rls)).toBe(0);
  });

  it("a failing contacts read aborts rather than removing memberships", async () => {
    rls.onSelect("contacts", () => ({ message: "connection reset by peer" }));
    await expect(syncCompanyRuleMemberships(db, TEST_USER, { full: true })).rejects.toThrow(
      "connection reset by peer",
    );
    expect(writeCount(rls)).toBe(0);
  });
});

describe("applyGroupRulesToAllContacts", () => {
  it("runs a full re-evaluation and reports the counts", async () => {
    rls.seed("contacts", [makeContactRow({ id: "mine", user_id: TEST_USER, email: "a@acme.com" })]);
    rls.seed("contact_group_rules", [
      {
        id: RULE_ID,
        user_id: TEST_USER,
        group_id: GROUP_ID,
        rule_type: "domain",
        value: "acme.com",
        auto_apply: true,
      },
    ]);
    const res = await call(applyGroupRulesToAllContacts, { data: {}, context: asUser });
    expect(res).toEqual({ scanned: 1, auto: 1, suggested: 0, removed: 0 });
  });
});
