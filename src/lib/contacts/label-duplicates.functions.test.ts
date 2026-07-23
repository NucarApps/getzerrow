// Tests for duplicate-label detection/merge (src/lib/contacts/label-duplicates.functions.ts).
//
// Focus: the destructive merge path `mergeLabelPair` (exercised via the
// `mergeLabelCluster` server fn and the exported `consolidateLabelDuplicatesImpl`)
// and its fail-recovery invariant — members are upserted onto the survivor and
// the source is only deleted afterwards, so a mid-merge failure leaves the
// source label (and its members) intact. mergeLabelCluster swallows per-source
// failures into a `failed` count, so we assert both the count and the absence
// of any destructive write.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

const reconcileAutoParentsForContacts = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./auto-company-subgroups.functions", () => ({
  reconcileAutoParentsForContacts: (...args: unknown[]) => reconcileAutoParentsForContacts(...args),
}));
const bumpResyncNonce = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/carddav/settings.functions", () => ({
  bumpResyncNonce: (...args: unknown[]) => bumpResyncNonce(...args),
}));

import { mergeLabelCluster, consolidateLabelDuplicatesImpl } from "./label-duplicates.functions";

const USER = "test-user-1"; // server-fn-stub TEST_USER
const CANON = "aaaaaaaa-1111-4111-8111-111111111111";
const SOURCE = "bbbbbbbb-2222-4222-8222-222222222222";
const ctx = { context: { supabase: fake.supabaseAdmin } };

/** Seed a contact_groups row with the columns the merge path reads. */
function group(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: USER,
    name: `G-${id}`,
    parent_group_id: null,
    auto_generated_from_group_id: null,
    color: null,
    carddav_uid: null,
    folder_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  fake.reset();
  reconcileAutoParentsForContacts.mockClear();
  bumpResyncNonce.mockClear();
});

/* -------------------------------------------------------------------------- */
/* mergeLabelCluster — guards                                                  */
/* -------------------------------------------------------------------------- */

describe("mergeLabelCluster — guards", () => {
  it("counts an unknown source label as a failure without any destructive write", async () => {
    // Neither group seeded → ownership check throws "Label not found".
    const res = await mergeLabelCluster({
      data: { canonicalId: CANON, foldIds: [SOURCE] },
      ...ctx,
    });
    expect(res.merged).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.errors[0]).toMatch(/Label not found/);
    expect(fake.calls.deletes.filter((d) => d.table === "contact_groups")).toHaveLength(0);
  });

  it("skips a fold id equal to the canonical id", async () => {
    const res = await mergeLabelCluster({
      data: { canonicalId: CANON, foldIds: [CANON] },
      ...ctx,
    });
    expect(res).toEqual({ merged: 0, failed: 0, movedMembers: 0, errors: [] });
  });
});

/* -------------------------------------------------------------------------- */
/* mergeLabelCluster — fail-recovery ordering                                  */
/* -------------------------------------------------------------------------- */

describe("mergeLabelCluster — fail-recovery ordering", () => {
  it("does not delete the source label when moving its members fails", async () => {
    fake.seed("contact_groups", [group(CANON), group(SOURCE)]);
    fake.seed("contact_group_members", [
      { group_id: SOURCE, contact_id: "c1", auto_added: false, source: "manual" },
    ]);
    fake.onUpsert("contact_group_members", () => ({ message: "member move boom" }));

    const res = await mergeLabelCluster({
      data: { canonicalId: CANON, foldIds: [SOURCE] },
      ...ctx,
    });

    expect(res.merged).toBe(0);
    expect(res.failed).toBe(1);
    // Neither the source label nor its members were destroyed.
    expect(fake.calls.deletes.filter((d) => d.table === "contact_groups")).toHaveLength(0);
    expect(fake.calls.deletes.filter((d) => d.table === "contact_group_members")).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* mergeLabelCluster — happy path                                              */
/* -------------------------------------------------------------------------- */

describe("mergeLabelCluster — happy path", () => {
  it("moves members onto the survivor, deletes the source, and converges", async () => {
    fake.seed("contact_groups", [group(CANON), group(SOURCE)]);
    fake.seed("contact_group_members", [
      { group_id: SOURCE, contact_id: "c1", auto_added: false, source: "manual" },
    ]);

    const res = await mergeLabelCluster({
      data: { canonicalId: CANON, foldIds: [SOURCE] },
      ...ctx,
    });

    expect(res.merged).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.movedMembers).toBe(1);

    // Member upserted onto the survivor before the source is deleted.
    const upsert = fake.calls.upserts.find((u) => u.table === "contact_group_members");
    expect((upsert?.payload as Array<Record<string, unknown>>)[0]).toMatchObject({
      group_id: CANON,
      contact_id: "c1",
    });
    // Source label deleted.
    const del = fake.calls.deletes.find((d) => d.table === "contact_groups");
    expect(del?.filters).toContainEqual({ op: "eq", col: "id", value: SOURCE });
    // Converge ran for the moved contact + bumped the CardDAV nonce.
    expect(reconcileAutoParentsForContacts).toHaveBeenCalledWith(expect.anything(), USER, ["c1"]);
    expect(bumpResyncNonce).toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* consolidateLabelDuplicatesImpl — deterministic bulk merge                   */
/* -------------------------------------------------------------------------- */

describe("consolidateLabelDuplicatesImpl", () => {
  it("clusters same-named labels in one scope and folds duplicates into the canonical", async () => {
    // Two identically-named root labels cluster by name; one is folded away.
    fake.seed("contact_groups", [group("g1", { name: "Honda" }), group("g2", { name: "Honda" })]);

    const res = await consolidateLabelDuplicatesImpl(fake.supabaseAdmin as never, USER);

    expect(res.mergedClusters).toBe(1);
    expect(res.mergedLabels).toBe(1);
    expect(res.failedLabels).toBe(0);
    // Exactly one of the two labels was deleted.
    expect(fake.calls.deletes.filter((d) => d.table === "contact_groups")).toHaveLength(1);
  });

  it("returns nothing to merge when labels are distinct", async () => {
    fake.seed("contact_groups", [
      group("g1", { name: "Attorneys" }),
      group("g2", { name: "Banks" }),
    ]);
    const res = await consolidateLabelDuplicatesImpl(fake.supabaseAdmin as never, USER);
    expect(res).toEqual({ mergedClusters: 0, mergedLabels: 0, failedLabels: 0, errors: [] });
  });
});
