// Company ↔ label linkage (company-groups.functions.ts). setCompanyLabels
// is a replace-all diff over contact_group_rules plus a companies.update,
// so the contracts worth pinning are the ones a refactor of that diff
// would break silently:
//
//   * every read and write is scoped by `user_id` on top of the id filter,
//     and the company is looked up under the caller's user_id before any
//     rule is touched — an unowned companyId throws "Company not found"
//     with zero writes,
//   * the diff is minimal: only genuinely-new groups are upserted, only
//     genuinely-dropped rules are deleted (BY RULE ID, not group id), and
//     an unchanged selection writes nothing and skips the membership sync,
//   * auto-generated subgroups are reconciler-managed and are silently
//     dropped from the add set — including from the linked_group_id pick,
//   * companies.linked_group_id keeps its current value while that label is
//     still selected, otherwise adopts the first addable one, otherwise
//     clears — and the UPDATE is skipped entirely when it would be a no-op,
//   * syncCompanyRuleMemberships runs only when the rule set actually
//     changed, and its counts are what the response reports.
//
// These handlers run on `context.supabase` (the RLS client). The user_id
// predicates asserted here are defence-in-depth over RLS, not a substitute
// for it; true cross-tenant isolation is proven in the DB-backed suite.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";

const rls = makeSupabaseFake({ applyWrites: true });

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

const syncCompanyRuleMemberships = vi.fn(async () => ({ scanned: 0, added: 0, removed: 0 }));
vi.mock("@/lib/contacts/group-rules.functions", () => ({
  syncCompanyRuleMemberships: (...a: unknown[]) => syncCompanyRuleMemberships(...(a as [])),
}));

const { listCompanyLabels, setCompanyLabels } = await import("./company-groups.functions");

const COMPANY = "11111111-1111-4111-8111-111111111111";
const G1 = "22222222-2222-4222-8222-222222222222";
const G2 = "33333333-3333-4333-8333-333333333333";
const G3 = "44444444-4444-4444-8444-444444444444";

// Both fns destructure `context.supabase` (the RLS client), which only the
// stub honours — so every call goes through `impersonate`, whose signature
// accepts the extra context key.
const ctx = { supabase: rls.supabaseAdmin };
const asUser = <T>(fn: T) => impersonate(fn, TEST_USER, ctx);
const call = (data: unknown) => asUser(setCompanyLabels)({ data });
const list = (data: unknown) => asUser(listCompanyLabels)({ data });

/** Seed an owned company plus the label rows the handler validates against. */
function seedOwned(opts: {
  groups?: Array<{ id: string; auto?: string }>;
  linked?: string | null;
}) {
  rls.seedRaw("companies", [
    { id: COMPANY, user_id: TEST_USER, linked_group_id: opts.linked ?? null },
  ]);
  rls.seedRaw(
    "contact_groups",
    (opts.groups ?? []).map((g) => ({
      id: g.id,
      user_id: TEST_USER,
      auto_generated_from_group_id: g.auto ?? null,
    })),
  );
}

beforeEach(() => {
  rls.reset();
  vi.clearAllMocks();
  syncCompanyRuleMemberships.mockResolvedValue({ scanned: 0, added: 0, removed: 0 });
});

describe("listCompanyLabels", () => {
  it("returns only auto_apply rules, scoped to the caller and rule type", async () => {
    rls.seedRaw("contact_group_rules", [
      {
        id: "r1",
        user_id: TEST_USER,
        rule_type: "company_id",
        value: COMPANY,
        group_id: G1,
        auto_apply: true,
      },
      {
        id: "r2",
        user_id: TEST_USER,
        rule_type: "company_id",
        value: COMPANY,
        group_id: G2,
        auto_apply: false,
      },
    ]);
    const res = await list({ companyId: COMPANY });
    expect(res).toEqual({ groupIds: [G1] });
    expect(rls.calls.selects[0]?.filters).toEqual([
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
      { op: "eq", col: "rule_type", value: "company_id", extra: undefined },
      { op: "eq", col: "value", value: COMPANY, extra: undefined },
    ]);
  });

  it("throws the underlying error rather than reporting no labels", async () => {
    rls.onSelect("contact_group_rules", () => ({ message: "read failed" }));
    await expect(list({ companyId: COMPANY })).rejects.toThrow("read failed");
  });

  it("rejects a non-uuid companyId", async () => {
    await expect(list({ companyId: "nope" })).rejects.toThrow();
  });
});

describe("setCompanyLabels", () => {
  it("refuses a company the caller does not own, before any write", async () => {
    rls.seedRaw("companies", [{ id: COMPANY, user_id: "someone-else" }]);
    await expect(call({ companyId: COMPANY, groupIds: [G1] })).rejects.toThrow("Company not found");
    expect(rls.calls.upserts).toEqual([]);
    expect(rls.calls.deletes).toEqual([]);
    expect(rls.calls.updates).toEqual([]);
    expect(syncCompanyRuleMemberships).not.toHaveBeenCalled();
  });

  it("adds a rule for a newly selected label and links the company to it", async () => {
    seedOwned({ groups: [{ id: G1 }] });
    syncCompanyRuleMemberships.mockResolvedValue({ scanned: 7, added: 3, removed: 0 });

    const res = await call({ companyId: COMPANY, groupIds: [G1] });

    expect(rls.calls.upserts[0]).toMatchObject({
      table: "contact_group_rules",
      payload: [
        {
          user_id: TEST_USER,
          group_id: G1,
          rule_type: "company_id",
          value: COMPANY,
          auto_apply: true,
        },
      ],
      options: { onConflict: "group_id,rule_type,value" },
    });
    expect(rls.calls.updates[0]).toMatchObject({
      table: "companies",
      payload: { linked_group_id: G1 },
    });
    expect(res).toEqual({
      ok: true,
      rulesAdded: 1,
      rulesRemoved: 0,
      scanned: 7,
      added: 3,
      removed: 0,
    });
  });

  it("deletes dropped rules by rule id, not by group id", async () => {
    seedOwned({ groups: [{ id: G1 }] });
    rls.seedRaw("contact_group_rules", [
      { id: "rule-1", user_id: TEST_USER, rule_type: "company_id", value: COMPANY, group_id: G1 },
      { id: "rule-2", user_id: TEST_USER, rule_type: "company_id", value: COMPANY, group_id: G2 },
    ]);

    const res = await call({ companyId: COMPANY, groupIds: [G1] });

    expect(rls.calls.deletes[0]?.filters).toEqual([
      { op: "in", col: "id", value: ["rule-2"], extra: undefined },
    ]);
    expect(res).toMatchObject({ rulesAdded: 0, rulesRemoved: 1 });
  });

  it("writes nothing and skips the sync when the selection is unchanged", async () => {
    seedOwned({ groups: [{ id: G1 }], linked: G1 });
    rls.seedRaw("contact_group_rules", [
      { id: "rule-1", user_id: TEST_USER, rule_type: "company_id", value: COMPANY, group_id: G1 },
    ]);

    const res = await call({ companyId: COMPANY, groupIds: [G1] });

    expect(rls.calls.upserts).toEqual([]);
    expect(rls.calls.deletes).toEqual([]);
    // linked_group_id already points at G1 — no UPDATE should be issued.
    expect(rls.calls.updates).toEqual([]);
    expect(syncCompanyRuleMemberships).not.toHaveBeenCalled();
    expect(res).toMatchObject({ rulesAdded: 0, rulesRemoved: 0, scanned: 0 });
  });

  it("silently skips auto-generated subgroups", async () => {
    seedOwned({ groups: [{ id: G1, auto: "parent-group" }, { id: G2 }] });

    const res = await call({ companyId: COMPANY, groupIds: [G1, G2] });

    expect(rls.calls.upserts[0]?.payload).toEqual([expect.objectContaining({ group_id: G2 })]);
    // …and the reconciler-managed group is not eligible to become the link.
    expect(rls.calls.updates[0]).toMatchObject({ payload: { linked_group_id: G2 } });
    expect(res).toMatchObject({ rulesAdded: 1 });
  });

  it("clears linked_group_id when the linked label is deselected and nothing replaces it", async () => {
    seedOwned({ groups: [{ id: G1 }], linked: G1 });
    rls.seedRaw("contact_group_rules", [
      { id: "rule-1", user_id: TEST_USER, rule_type: "company_id", value: COMPANY, group_id: G1 },
    ]);

    await call({ companyId: COMPANY, groupIds: [] });

    expect(rls.calls.updates[0]).toMatchObject({ payload: { linked_group_id: null } });
  });

  it("keeps the existing link when it is still selected alongside a new label", async () => {
    seedOwned({ groups: [{ id: G1 }, { id: G2 }], linked: G2 });
    rls.seedRaw("contact_group_rules", [
      { id: "rule-2", user_id: TEST_USER, rule_type: "company_id", value: COMPANY, group_id: G2 },
    ]);

    await call({ companyId: COMPANY, groupIds: [G1, G2] });

    expect(rls.calls.upserts[0]?.payload).toEqual([expect.objectContaining({ group_id: G1 })]);
    // G1 sorts first in the selection but must not steal the link from G2.
    expect(rls.calls.updates).toEqual([]);
  });

  it("scopes the companies update to the caller as well as the company", async () => {
    seedOwned({ groups: [{ id: G1 }] });
    await call({ companyId: COMPANY, groupIds: [G1] });
    expect(rls.calls.updates[0]?.filters).toEqual([
      { op: "eq", col: "id", value: COMPANY, extra: undefined },
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
    ]);
  });

  it("syncs memberships for exactly this company, bumping the resync marker", async () => {
    seedOwned({ groups: [{ id: G1 }] });
    await call({ companyId: COMPANY, groupIds: [G1] });
    expect(syncCompanyRuleMemberships).toHaveBeenCalledWith(rls.supabaseAdmin, TEST_USER, {
      companyIds: [COMPANY],
      bumpResync: true,
    });
  });

  it("throws when the rule read, upsert or delete fails", async () => {
    seedOwned({ groups: [{ id: G1 }] });
    rls.onSelect("contact_group_rules", () => ({ message: "rules read failed" }));
    await expect(call({ companyId: COMPANY, groupIds: [G1] })).rejects.toThrow("rules read failed");

    rls.reset();
    seedOwned({ groups: [{ id: G1 }] });
    rls.onUpsert("contact_group_rules", () => ({ message: "upsert failed" }));
    await expect(call({ companyId: COMPANY, groupIds: [G1] })).rejects.toThrow("upsert failed");
    expect(syncCompanyRuleMemberships).not.toHaveBeenCalled();
  });

  it("rejects a selection over the 50-label cap", async () => {
    const groupIds = Array.from({ length: 51 }, () => G3);
    await expect(call({ companyId: COMPANY, groupIds })).rejects.toThrow();
  });
});
