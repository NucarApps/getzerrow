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
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import { asSupabaseAdmin } from "./__fixtures__/rows";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const reconcileAutoParentsForContacts = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./auto-company-subgroups.functions", () => ({
  reconcileAutoParentsForContacts: (...args: unknown[]) => reconcileAutoParentsForContacts(...args),
}));
const bumpResyncNonce = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/carddav/settings.functions", () => ({
  bumpResyncNonce: (...args: unknown[]) => bumpResyncNonce(...args),
}));

vi.mock("@/lib/ai-gateway", () => ({ getModel: () => ({ modelId: "test-model" }) }));

type AiClusters = { clusters: Array<{ canonicalName: string; fold: string[]; rationale: string }> };
const generateText = vi.fn<() => Promise<{ output: AiClusters }>>();
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  // Output and NoObjectGeneratedError stay real: the handler branches on
  // `NoObjectGeneratedError.isInstance(e)`, so a stub would decide the test.
  return { ...actual, generateText: () => generateText() };
});

import {
  findDuplicateLabels,
  mergeLabelCluster,
  consolidateLabelDuplicatesImpl,
} from "./label-duplicates.functions";

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

    const res = await consolidateLabelDuplicatesImpl(asSupabaseAdmin(fake), USER);

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
    const res = await consolidateLabelDuplicatesImpl(asSupabaseAdmin(fake), USER);
    expect(res).toEqual({ mergedClusters: 0, mergedLabels: 0, failedLabels: 0, errors: [] });
  });
});

/* -------------------------------------------------------------------------- */
/* mergeLabelPair — the parts the happy path does not reach                     */
/* -------------------------------------------------------------------------- */

describe("mergeLabelPair — ownership, flags and re-pointing", () => {
  it("refuses to fold another user's label into the caller's, destroying nothing", async () => {
    fake.seed("contact_groups", [group(CANON), group(SOURCE, { user_id: "victim-user" })]);
    fake.seed("contact_group_members", [
      { group_id: SOURCE, contact_id: "c1", auto_added: false, source: "manual" },
    ]);

    const res = await mergeLabelCluster({
      data: { canonicalId: CANON, foldIds: [SOURCE] },
      ...ctx,
    });

    expect(res).toMatchObject({ merged: 0, failed: 1 });
    expect(res.errors[0]).toMatch(/Label not found/);
    expect(fake.calls.deletes).toStrictEqual([]);
    expect(fake.calls.upserts).toStrictEqual([]);
  });

  it("refuses when the caller does not own the survivor either", async () => {
    fake.seed("contact_groups", [group(CANON, { user_id: "victim-user" }), group(SOURCE)]);

    const res = await mergeLabelCluster({
      data: { canonicalId: CANON, foldIds: [SOURCE] },
      ...ctx,
    });

    expect(res).toMatchObject({ merged: 0, failed: 1 });
    expect(fake.calls.deletes).toStrictEqual([]);
  });

  it("keeps each moved member's own auto/source flags when the survivor is user-owned", async () => {
    fake.seed("contact_groups", [group(CANON), group(SOURCE)]);
    fake.seed("contact_group_members", [
      { group_id: SOURCE, contact_id: "c1", auto_added: true, source: "company_subgroup" },
      // A row with no source at all falls back to "manual".
      { group_id: SOURCE, contact_id: "c2", auto_added: false, source: null },
    ]);

    await mergeLabelCluster({ data: { canonicalId: CANON, foldIds: [SOURCE] }, ...ctx });

    const upsert = fake.calls.upserts.find((u) => u.table === "contact_group_members");
    expect(upsert?.payload).toStrictEqual([
      {
        user_id: USER,
        group_id: CANON,
        contact_id: "c1",
        auto_added: true,
        source: "company_subgroup",
      },
      { user_id: USER, group_id: CANON, contact_id: "c2", auto_added: false, source: "manual" },
    ]);
    expect(upsert?.options).toStrictEqual({
      onConflict: "group_id,contact_id",
      ignoreDuplicates: true,
    });
  });

  it("hands every moved member to the reconciler when the survivor is auto-generated", async () => {
    fake.seed("contact_groups", [
      group(CANON, { auto_generated_from_group_id: "parent-1" }),
      group(SOURCE),
    ]);
    fake.seed("contact_group_members", [
      { group_id: SOURCE, contact_id: "c1", auto_added: false, source: "manual" },
    ]);

    await mergeLabelCluster({ data: { canonicalId: CANON, foldIds: [SOURCE] }, ...ctx });

    const upsert = fake.calls.upserts.find((u) => u.table === "contact_group_members");
    expect(upsert?.payload).toStrictEqual([
      {
        user_id: USER,
        group_id: CANON,
        contact_id: "c1",
        auto_added: true,
        source: "company_subgroup",
      },
    ]);
  });

  it("reparents both the structural and the auto-parent pointers of the source's children", async () => {
    fake.seed("contact_groups", [
      group(CANON),
      group(SOURCE),
      group("child-1", { parent_group_id: SOURCE }),
      group("child-2", { auto_generated_from_group_id: SOURCE }),
      // Another user's child must not be touched.
      group("child-3", { parent_group_id: SOURCE, user_id: "victim-user" }),
    ]);

    await mergeLabelCluster({ data: { canonicalId: CANON, foldIds: [SOURCE] }, ...ctx });

    const updates = fake.calls.updates.filter((u) => u.table === "contact_groups");
    expect(updates[0]).toStrictEqual({
      table: "contact_groups",
      payload: { parent_group_id: CANON },
      options: undefined,
      filters: [
        { op: "eq", col: "user_id", value: USER, extra: undefined },
        { op: "eq", col: "parent_group_id", value: SOURCE, extra: undefined },
      ],
    });
    expect(updates[1]?.payload).toStrictEqual({ auto_generated_from_group_id: CANON });
  });

  it("migrates the folder link and re-points sender_in_group rules at the survivor", async () => {
    fake.seed("contact_groups", [group(CANON), group(SOURCE, { folder_id: "folder-9" })]);
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: "folder-9", op: "sender_in_group", value: SOURCE },
    ]);

    await mergeLabelCluster({ data: { canonicalId: CANON, foldIds: [SOURCE] }, ...ctx });

    const groupUpdates = fake.calls.updates.filter((u) => u.table === "contact_groups");
    const linkMigration = groupUpdates.find((u) => "folder_id" in (u.payload as object));
    expect(linkMigration?.payload).toStrictEqual({ folder_id: "folder-9" });
    expect(linkMigration?.filters).toStrictEqual([
      { op: "eq", col: "id", value: CANON, extra: undefined },
    ]);

    expect(fake.calls.updates.filter((u) => u.table === "folder_filters")).toStrictEqual([
      {
        table: "folder_filters",
        payload: { value: CANON },
        options: undefined,
        filters: [
          { op: "eq", col: "op", value: "sender_in_group", extra: undefined },
          { op: "eq", col: "value", value: SOURCE, extra: undefined },
        ],
      },
    ]);
  });

  it("keeps the survivor's own folder link but still re-points the rules", async () => {
    fake.seed("contact_groups", [
      group(CANON, { folder_id: "folder-keep" }),
      group(SOURCE, { folder_id: "folder-9" }),
    ]);

    await mergeLabelCluster({ data: { canonicalId: CANON, foldIds: [SOURCE] }, ...ctx });

    const groupUpdates = fake.calls.updates.filter((u) => u.table === "contact_groups");
    expect(groupUpdates.some((u) => "folder_id" in (u.payload as object))).toBe(false);
    expect(fake.calls.updates.filter((u) => u.table === "folder_filters")).toHaveLength(1);
  });

  it("touches no folder wiring when the source had no folder link", async () => {
    fake.seed("contact_groups", [group(CANON), group(SOURCE)]);

    await mergeLabelCluster({ data: { canonicalId: CANON, foldIds: [SOURCE] }, ...ctx });

    expect(fake.calls.updates.filter((u) => u.table === "folder_filters")).toStrictEqual([]);
  });

  it("keeps going after one source fails and reports at most three errors", async () => {
    const folds = Array.from(
      { length: 5 },
      (_, i) => `cccccccc-${i}${i}${i}${i}-4111-8111-111111111111`,
    );
    // Only the survivor exists, so every fold fails ownership.
    fake.seed("contact_groups", [group(CANON)]);

    const res = await mergeLabelCluster({ data: { canonicalId: CANON, foldIds: folds }, ...ctx });

    expect(res.failed).toBe(5);
    expect(res.errors).toHaveLength(3);
    expect(reconcileAutoParentsForContacts).not.toHaveBeenCalled();
    expect(bumpResyncNonce).not.toHaveBeenCalled();
  });

  it("still reports the merge when the post-merge convergence throws", async () => {
    fake.seed("contact_groups", [group(CANON), group(SOURCE)]);
    fake.seed("contact_group_members", [
      { group_id: SOURCE, contact_id: "c1", auto_added: false, source: "manual" },
    ]);
    reconcileAutoParentsForContacts.mockRejectedValue(new Error("reconciler down"));

    const res = await mergeLabelCluster({
      data: { canonicalId: CANON, foldIds: [SOURCE] },
      ...ctx,
    });

    expect(res).toMatchObject({ merged: 1, failed: 0, movedMembers: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/* findDuplicateLabels                                                         */
/* -------------------------------------------------------------------------- */

describe("findDuplicateLabels — deterministic pass", () => {
  it("proposes the canonical, marks only the others for folding, and explains why", async () => {
    fake.seed("contact_groups", [
      group("g-small", { name: "Honda" }),
      group("g-big", { name: "Honda" }),
    ]);
    // g-big has more members, so it is the canonical.
    fake.seed("contact_group_members", [
      { group_id: "g-big", contact_id: "c1" },
      { group_id: "g-big", contact_id: "c2" },
      { group_id: "g-small", contact_id: "c3" },
    ]);

    const res = await findDuplicateLabels({ data: {}, ...ctx });

    expect(res.aiUsed).toBe(false);
    expect(res.aiError).toBeNull();
    expect(res.clusters).toStrictEqual([
      {
        canonicalId: "g-big",
        canonicalName: "Honda",
        parentGroupId: null,
        rationale: "Same normalized name within the same parent label.",
        members: [
          { id: "g-small", name: "Honda", member_count: 1, is_auto: false, include: true },
          { id: "g-big", name: "Honda", member_count: 2, is_auto: false, include: false },
        ],
      },
    ]);
  });

  it("clusters labels whose members resolve to the same company, whatever they are called", async () => {
    fake.seed("contact_groups", [
      group("g-a", { name: "Nissan Motor Acceptance" }),
      group("g-b", { name: "Boston Dealer Group" }),
    ]);
    fake.seed("contact_group_members", [
      { group_id: "g-a", contact_id: "c1" },
      { group_id: "g-b", contact_id: "c2" },
    ]);
    fake.seed("contacts", [
      { id: "c1", user_id: USER, company_id: "co-nissan" },
      { id: "c2", user_id: USER, company_id: "co-nissan" },
    ]);

    const res = await findDuplicateLabels({ data: {}, ...ctx });

    expect(res.clusters).toHaveLength(1);
    expect(res.clusters[0]?.rationale).toBe(
      "These labels' contacts all belong to the same company.",
    );
    expect(res.clusters[0]?.members.map((m) => m.id).sort()).toStrictEqual(["g-a", "g-b"]);
  });

  it("surfaces a failed label read instead of reporting no duplicates", async () => {
    fake.onSelect("contact_groups", () => ({ message: "statement timeout" }));

    await expect(findDuplicateLabels({ data: {}, ...ctx })).rejects.toThrow("statement timeout");
  });

  it("returns no clusters and never calls the model when the user has one label", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test-key");
    fake.seed("contact_groups", [group("g1", { name: "Attorneys" })]);

    expect(await findDuplicateLabels({ data: { useAi: true }, ...ctx })).toStrictEqual({
      clusters: [],
      aiUsed: false,
      aiError: null,
    });
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe("findDuplicateLabels — AI fold", () => {
  beforeEach(() => {
    vi.stubEnv("LOVABLE_API_KEY", "test-key");
    fake.seed("contact_groups", [
      group("g-vw", { name: "VW" }),
      group("g-volkswagen", { name: "Volkswagen" }),
    ]);
  });

  it("appends the model's near-match cluster to the deterministic ones", async () => {
    generateText.mockResolvedValue({
      output: {
        clusters: [{ canonicalName: "Volkswagen", fold: ["VW"], rationale: "Brand initialism." }],
      },
    });

    const res = await findDuplicateLabels({ data: { useAi: true }, ...ctx });

    expect(res.aiUsed).toBe(true);
    expect(res.aiError).toBeNull();
    expect(res.clusters).toStrictEqual([
      {
        canonicalId: "g-volkswagen",
        canonicalName: "Volkswagen",
        parentGroupId: null,
        rationale: "Brand initialism.",
        members: [
          {
            id: "g-volkswagen",
            name: "Volkswagen",
            member_count: 0,
            is_auto: false,
            include: false,
          },
          { id: "g-vw", name: "VW", member_count: 0, is_auto: false, include: true },
        ],
      },
    ]);
  });

  it("drops a proposal naming labels that do not exist", async () => {
    generateText.mockResolvedValue({
      output: {
        clusters: [
          { canonicalName: "Audi", fold: ["Skoda"], rationale: "Same group." },
          // Canonical exists but nothing foldable survives the lookup.
          { canonicalName: "Volkswagen", fold: ["Seat"], rationale: "Same group." },
        ],
      },
    });

    const res = await findDuplicateLabels({ data: { useAi: true }, ...ctx });

    expect(res.aiUsed).toBe(true);
    expect(res.clusters).toStrictEqual([]);
  });

  it("does not offer the model labels the deterministic pass already clustered", async () => {
    fake.seed("contact_groups", [
      group("g-vw", { name: "VW" }),
      group("g-volkswagen", { name: "Volkswagen" }),
      group("g-honda-1", { name: "Honda" }),
      group("g-honda-2", { name: "Honda" }),
    ]);
    generateText.mockResolvedValue({ output: { clusters: [] } });

    await findDuplicateLabels({ data: { useAi: true }, ...ctx });

    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("reports a missing API key without attempting a call", async () => {
    vi.stubEnv("LOVABLE_API_KEY", undefined);

    const res = await findDuplicateLabels({ data: { useAi: true }, ...ctx });

    expect(res).toMatchObject({ aiUsed: false, aiError: "Missing LOVABLE_API_KEY" });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("reports an unparseable model response without failing the whole request", async () => {
    const { NoObjectGeneratedError } = await import("ai");
    generateText.mockRejectedValue(
      new NoObjectGeneratedError({
        message: "no object generated",
        text: "not json",
        response: { id: "r-1", timestamp: new Date("2026-09-03T00:00:00Z"), modelId: "test-model" },
        usage: {
          inputTokens: 10,
          outputTokens: 0,
          totalTokens: 10,
          inputTokenDetails: {
            noCacheTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
        },
        finishReason: "stop",
      }),
    );

    const res = await findDuplicateLabels({ data: { useAi: true }, ...ctx });

    expect(res).toMatchObject({ aiUsed: false, aiError: "AI returned an unparseable response" });
  });

  it("keeps the deterministic clusters when the model call fails outright", async () => {
    fake.seed("contact_groups", [
      group("g-honda-1", { name: "Honda" }),
      group("g-honda-2", { name: "Honda" }),
      group("g-vw", { name: "VW" }),
      group("g-volkswagen", { name: "Volkswagen" }),
    ]);
    generateText.mockRejectedValue(new Error("gateway 503"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await findDuplicateLabels({ data: { useAi: true }, ...ctx });

    expect(res.aiError).toBe("gateway 503");
    expect(res.aiUsed).toBe(false);
    expect(res.clusters.map((c) => c.canonicalName)).toStrictEqual(["Honda"]);
  });

  it("skips the model when no parent scope has two unclustered labels left", async () => {
    fake.seed("contact_groups", [
      group("g-honda-1", { name: "Honda" }),
      group("g-honda-2", { name: "Honda" }),
      group("g-lonely", { name: "Attorneys" }),
    ]);

    const res = await findDuplicateLabels({ data: { useAi: true }, ...ctx });

    expect(generateText).not.toHaveBeenCalled();
    expect(res).toMatchObject({ aiUsed: false, aiError: null });
  });
});
