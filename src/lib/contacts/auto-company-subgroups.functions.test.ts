// Auto company subgroups (auto-company-subgroups.functions.ts). Contracts
// protected:
//
//   * every exported server fn goes through assertOwnsGroup first, so a
//     foreign label id is refused with zero writes,
//   * a reconciler-managed subgroup cannot itself be turned into a parent,
//   * pruneAutoCompanySubgroups deletes only the subgroups generated FROM
//     the named parent,
//   * a reconcile of an already-consistent parent is a no-op: it must not
//     churn memberships (this engine runs on every contact edit, so a
//     non-idempotent pass would rewrite the whole label set each time),
//   * reconcileAllAutoGroups chunks its stale-membership prune at 500 ids
//     so a large account does not build one enormous `in(...)` filter,
//   * reconcileIfAuto is a silent no-op for a group the caller does not own
//     or that has the toggle off.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";
import { makeContactRow, makeGroupRow, makeGroupMemberRow } from "./__fixtures__/rows";

const rls = makeSupabaseFake({ applyWrites: true });

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import {
  setAutoCompanySubgroups,
  reconcileAutoCompanySubgroups,
  pruneAutoCompanySubgroups,
  reconcileAllAutoGroups,
  reconcileAutoCompanySubgroupsImpl,
  reconcileIfAuto,
} from "./auto-company-subgroups.functions";
import type { DB } from "@/lib/supabase-db";

const PARENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONTACT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VICTIM = "victim-user-2";
const ATTACKER = "attacker-user-9";

type CallArgs = { data?: unknown; context?: Record<string, unknown> };
function call(fn: unknown, args: CallArgs): Promise<never> {
  return (fn as (a: CallArgs) => Promise<never>)(args);
}
const asUser = { supabase: rls.supabaseAdmin };
const asAttacker = { supabase: rls.supabaseAdmin, userId: ATTACKER };
const db = rls.supabaseAdmin as unknown as DB;

beforeEach(() => {
  rls.reset();
});

describe("assertOwnsGroup", () => {
  const foreign = () =>
    rls.seed("contact_groups", [makeGroupRow({ id: PARENT_ID, user_id: VICTIM })]);

  it("setAutoCompanySubgroups refuses another tenant's label", async () => {
    foreign();
    await expectDeniedCrossUser({
      fake: rls,
      rejects: "Group not found",
      call: () =>
        call(setAutoCompanySubgroups, {
          data: { groupId: PARENT_ID, enabled: true },
          context: asAttacker,
        }),
    });
  });

  it("reconcileAutoCompanySubgroups refuses another tenant's label", async () => {
    foreign();
    await expectDeniedCrossUser({
      fake: rls,
      rejects: "Group not found",
      call: () =>
        call(reconcileAutoCompanySubgroups, { data: { groupId: PARENT_ID }, context: asAttacker }),
    });
  });

  it("pruneAutoCompanySubgroups refuses another tenant's label", async () => {
    foreign();
    rls.seed("contact_groups", [
      makeGroupRow({ id: PARENT_ID, user_id: VICTIM }),
      makeGroupRow({ id: SUB_ID, user_id: VICTIM, auto_generated_from_group_id: PARENT_ID }),
    ]);
    await expectDeniedCrossUser({
      fake: rls,
      rejects: "Group not found",
      call: () =>
        call(pruneAutoCompanySubgroups, { data: { groupId: PARENT_ID }, context: asAttacker }),
    });
    expect(rls.rows("contact_groups")).toHaveLength(2);
  });
});

describe("setAutoCompanySubgroups", () => {
  it("refuses to make a reconciler-managed subgroup into a parent", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: SUB_ID, user_id: TEST_USER, auto_generated_from_group_id: PARENT_ID }),
    ]);
    await expect(
      call(setAutoCompanySubgroups, {
        data: { groupId: SUB_ID, enabled: true },
        context: asUser,
      }),
    ).rejects.toThrow("managed automatically");
    expect(writeCount(rls)).toBe(0);
  });

  it("turning the toggle off writes the flag and runs no reconcile", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: PARENT_ID, user_id: TEST_USER, auto_company_subgroups: true }),
    ]);
    const res = (await call(setAutoCompanySubgroups, {
      data: { groupId: PARENT_ID, enabled: false },
      context: asUser,
    })) as unknown as { ok: boolean; stats: unknown };
    expect(res).toEqual({ ok: true, stats: null });
    expect(rls.calls.updates).toHaveLength(1);
    expect(rls.calls.updates[0]!.payload).toStrictEqual({ auto_company_subgroups: false });
    expect(rls.rows("contact_groups")[0]).toMatchObject({ auto_company_subgroups: false });
  });

  it("a failing toggle write surfaces before any reconcile", async () => {
    rls.seed("contact_groups", [makeGroupRow({ id: PARENT_ID, user_id: TEST_USER })]);
    rls.onUpdate("contact_groups", () => ({ message: "permission denied" }));
    await expect(
      call(setAutoCompanySubgroups, {
        data: { groupId: PARENT_ID, enabled: true },
        context: asUser,
      }),
    ).rejects.toThrow("permission denied");
  });
});

describe("pruneAutoCompanySubgroups", () => {
  it("deletes only the subgroups generated from the named parent", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: PARENT_ID, user_id: TEST_USER }),
      makeGroupRow({ id: SUB_ID, user_id: TEST_USER, auto_generated_from_group_id: PARENT_ID }),
      makeGroupRow({ id: "other-sub", user_id: TEST_USER, auto_generated_from_group_id: "other" }),
      makeGroupRow({ id: "manual", user_id: TEST_USER }),
    ]);
    const res = (await call(pruneAutoCompanySubgroups, {
      data: { groupId: PARENT_ID },
      context: asUser,
    })) as unknown as { removed: number };
    expect(res).toEqual({ removed: 1 });
    expect(
      rls
        .rows("contact_groups")
        .map((g) => g.id)
        .sort(),
    ).toStrictEqual([PARENT_ID, "manual", "other-sub"]);
  });

  it("reports zero and issues no delete when there is nothing to prune", async () => {
    rls.seed("contact_groups", [makeGroupRow({ id: PARENT_ID, user_id: TEST_USER })]);
    const res = (await call(pruneAutoCompanySubgroups, {
      data: { groupId: PARENT_ID },
      context: asUser,
    })) as unknown as { removed: number };
    expect(res).toEqual({ removed: 0 });
    expect(writeCount(rls)).toBe(0);
  });
});

describe("reconcileAutoCompanySubgroupsImpl", () => {
  /** The reconciler reads its parent members through a PostgREST embed
   * (`contacts:contacts(...)`), which the fake does not compute — so the
   * membership seeds below carry the joined contact inline, exactly as the
   * server would return it. */
  function memberRow(
    over: { group_id: string; contact_id: string; auto_added?: boolean; source?: string },
    contact: { id: string; company: string | null; email: string | null } | null,
  ) {
    return {
      ...makeGroupMemberRow({
        group_id: over.group_id,
        contact_id: over.contact_id,
        auto_added: over.auto_added ?? false,
        source: over.source ?? null,
        user_id: TEST_USER,
      }),
      contacts: contact
        ? {
            id: contact.id,
            company: contact.company,
            email: contact.email,
            website: null,
            company_id: null,
          }
        : null,
    };
  }
  const acmeContact = (id: string, email: string) => ({ id, company: "Acme", email });

  /** A parent label with one manual member at Acme, an existing Acme auto
   * subgroup, and both Acme contacts already filed in both places — the
   * steady state the reconciler is supposed to converge on. */
  function seedConsistentState() {
    rls.seed("contact_groups", [
      makeGroupRow({ id: PARENT_ID, user_id: TEST_USER, auto_company_subgroups: true }),
      makeGroupRow({
        id: SUB_ID,
        user_id: TEST_USER,
        name: "Acme",
        parent_group_id: PARENT_ID,
        auto_generated_from_group_id: PARENT_ID,
      }),
    ]);
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, company: "Acme" }),
      makeContactRow({ id: "c2", user_id: TEST_USER, company: "Acme", email: "b@acme.com" }),
    ]);
    rls.seedRaw("contact_group_members", [
      memberRow(
        { group_id: PARENT_ID, contact_id: CONTACT_ID },
        acmeContact(CONTACT_ID, "ada@acme.com"),
      ),
      memberRow(
        { group_id: PARENT_ID, contact_id: "c2", auto_added: true, source: "company_subgroup" },
        acmeContact("c2", "b@acme.com"),
      ),
      memberRow(
        { group_id: SUB_ID, contact_id: CONTACT_ID, auto_added: true },
        acmeContact(CONTACT_ID, "ada@acme.com"),
      ),
      memberRow(
        { group_id: SUB_ID, contact_id: "c2", auto_added: true },
        acmeContact("c2", "b@acme.com"),
      ),
    ]);
  }

  it("pulls a matching stranger into the parent and its company subgroup", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: PARENT_ID, user_id: TEST_USER, auto_company_subgroups: true }),
      makeGroupRow({
        id: SUB_ID,
        user_id: TEST_USER,
        name: "Acme",
        auto_generated_from_group_id: PARENT_ID,
      }),
    ]);
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, company: "Acme" }),
      // Same company, not in the label yet.
      makeContactRow({ id: "c2", user_id: TEST_USER, company: "Acme", email: "b@acme.com" }),
      // Different company, and another tenant's Acme contact: neither joins.
      makeContactRow({ id: "c3", user_id: TEST_USER, company: "Globex", email: "c@globex.io" }),
      makeContactRow({ id: "foreign", user_id: VICTIM, company: "Acme", email: "v@acme.com" }),
    ]);
    rls.seedRaw("contact_group_members", [
      memberRow(
        { group_id: PARENT_ID, contact_id: CONTACT_ID },
        acmeContact(CONTACT_ID, "ada@acme.com"),
      ),
    ]);

    const stats = await reconcileAutoCompanySubgroupsImpl(db, TEST_USER, PARENT_ID);
    expect(stats).toMatchObject({ created: 0, removed: 0, renamed: 0 });
    const added = rls.calls.upserts.flatMap(
      (u) => u.payload as Array<{ group_id: string; contact_id: string; user_id: string }>,
    );
    expect(added).toStrictEqual([
      {
        group_id: PARENT_ID,
        contact_id: "c2",
        user_id: TEST_USER,
        auto_added: true,
        source: "company_subgroup",
      },
      {
        group_id: SUB_ID,
        contact_id: CONTACT_ID,
        user_id: TEST_USER,
        auto_added: true,
        source: "company_subgroup",
      },
      {
        group_id: SUB_ID,
        contact_id: "c2",
        user_id: TEST_USER,
        auto_added: true,
        source: "company_subgroup",
      },
    ]);
  });

  it("a reconcile of an already-consistent parent writes nothing", async () => {
    seedConsistentState();
    const stats = await reconcileAutoCompanySubgroupsImpl(db, TEST_USER, PARENT_ID);
    expect(stats).toStrictEqual({
      created: 0,
      removed: 0,
      renamed: 0,
      membershipsAdded: 0,
      membershipsRemoved: 0,
    });
    expect(writeCount(rls)).toBe(0);
  });

  it("only removes auto rows this engine owns, never manual or rule rows", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: PARENT_ID, user_id: TEST_USER, auto_company_subgroups: true }),
      makeGroupRow({
        id: SUB_ID,
        user_id: TEST_USER,
        name: "Acme",
        auto_generated_from_group_id: PARENT_ID,
      }),
    ]);
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, company: "Acme" }),
      // Was auto-added under a company the parent no longer represents.
      makeContactRow({ id: "stale", user_id: TEST_USER, company: "Globex", email: "s@globex.io" }),
    ]);
    rls.seedRaw("contact_group_members", [
      memberRow(
        { group_id: PARENT_ID, contact_id: CONTACT_ID },
        acmeContact(CONTACT_ID, "ada@acme.com"),
      ),
      memberRow(
        { group_id: PARENT_ID, contact_id: "stale", auto_added: true, source: "company_subgroup" },
        {
          id: "stale",
          company: "Globex",
          email: "s@globex.io",
        },
      ),
    ]);
    await reconcileAutoCompanySubgroupsImpl(db, TEST_USER, PARENT_ID);
    const del = rls.calls.deletes.find((d) => d.table === "contact_group_members")!;
    expect(del.filters).toStrictEqual([
      { op: "eq", col: "group_id", value: PARENT_ID, extra: undefined },
      { op: "eq", col: "auto_added", value: true, extra: undefined },
      { op: "eq", col: "source", value: "company_subgroup", extra: undefined },
      { op: "in", col: "contact_id", value: ["stale"], extra: undefined },
    ]);
  });

  it("a failing member read aborts rather than deleting anything", async () => {
    rls.onSelect("contact_group_members", () => ({ message: "statement timeout" }));
    await expect(reconcileAutoCompanySubgroupsImpl(db, TEST_USER, PARENT_ID)).rejects.toThrow(
      "statement timeout",
    );
    expect(writeCount(rls)).toBe(0);
  });
});

describe("reconcileIfAuto", () => {
  it("is a silent no-op for another tenant's group", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: PARENT_ID, user_id: VICTIM, auto_company_subgroups: true }),
    ]);
    await expect(reconcileIfAuto(db, ATTACKER, PARENT_ID)).resolves.toBeUndefined();
    expect(writeCount(rls)).toBe(0);
  });

  it("is a silent no-op when the toggle is off", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: PARENT_ID, user_id: TEST_USER, auto_company_subgroups: false }),
    ]);
    await reconcileIfAuto(db, TEST_USER, PARENT_ID);
    expect(writeCount(rls)).toBe(0);
    // The reconcile itself never started: no member read followed the check.
    expect(rls.calls.selects.map((s) => s.table)).toStrictEqual(["contact_groups"]);
  });
});

describe("reconcileAllAutoGroups", () => {
  it("chunks the stale-membership prune at 500 contact ids", async () => {
    rls.seed(
      "contacts",
      Array.from({ length: 501 }, (_, i) =>
        makeContactRow({ id: `c${i}`, user_id: TEST_USER, email: `c${i}@acme.com` }),
      ),
    );
    await call(reconcileAllAutoGroups, { data: {}, context: asUser });
    const idBatches = rls.calls.selects
      .filter((s) => s.table === "contact_group_members")
      .flatMap((s) => s.filters)
      .filter((f) => f.op === "in" && f.col === "contact_id")
      .map((f) => (f.value as string[]).length);
    // The stale-membership prune runs first (500 + 1), then the rule-sync
    // pass at the end of the fn chunks the same ids the same way.
    expect(idBatches.slice(0, 2)).toStrictEqual([500, 1]);
    expect(idBatches.every((n) => n <= 500)).toBe(true);
  });

  it("reports the reconciled parents and skips one that fails", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: PARENT_ID, user_id: TEST_USER, auto_company_subgroups: true }),
      makeGroupRow({ id: "p2", user_id: TEST_USER, auto_company_subgroups: true }),
      makeGroupRow({ id: "not-auto", user_id: TEST_USER, auto_company_subgroups: false }),
      makeGroupRow({ id: "foreign", user_id: VICTIM, auto_company_subgroups: true }),
    ]);
    const res = (await call(reconcileAllAutoGroups, {
      data: {},
      context: asUser,
    })) as unknown as { reconciled: number };
    // Both of the caller's auto parents ran; the foreign one was never read.
    expect(res.reconciled).toBe(2);
  });
});
