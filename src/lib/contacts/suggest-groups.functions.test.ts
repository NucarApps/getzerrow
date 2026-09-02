// AI group suggestions (src/lib/contacts/suggest-groups.functions.ts).
// Contracts protected:
//
//   * applySuggestionImpl's status guards, the existing-vs-resolved target
//     branch, and the fail-recovery invariant that a suggestion is NOT
//     marked accepted when the membership write fails,
//   * a CLIENT-CHOSEN target_group_id is verified against the caller before
//     any membership upsert — this fn is also called with the admin client
//     from the background gate, where RLS would not save us,
//   * a suggestion belonging to another tenant is not found, with no writes,
//   * runContactGroupSuggestionsImpl maps the model's short indices back to
//     real contact ids, drops invented ones and clusters under two members,
//     and writes the suggestion rows with the caller's user_id,
//   * the five-minute rescan cooldown returns the cached run instead of
//     calling the model again.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { asSupabaseAdmin, makeContactRow, makeGroupRow } from "./__fixtures__/rows";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (t: string) => fake.supabaseAdmin.from(t) },
}));
vi.mock("@/lib/log.server", () => ({ logInfo: vi.fn() }));
vi.mock("@/lib/sync/encrypted-reader", () => ({
  getEmailsDecrypted: vi.fn(async () => ({ rows: [], error: null })),
  searchEmailsParticipantsDecrypted: vi.fn(async () => ({ rows: [], error: null })),
}));

const generateText = vi.fn();
vi.mock("ai", () => ({
  generateText: (args: unknown) => generateText(args),
  Output: { object: (o: unknown) => o },
  NoObjectGeneratedError: { isInstance: () => false },
}));
vi.mock("@/lib/ai-gateway", () => ({
  getModel: () => ({ modelId: "test-model" }),
  getGateway: () => () => ({ modelId: "test-model" }),
  describeError: (e: unknown) => (e as Error)?.message ?? "unknown",
}));

const resolveOrCreateCompanyLabel = vi.fn(async (..._args: unknown[]) => ({
  id: "resolved-group",
}));
vi.mock("./label-resolve.server", () => ({
  resolveOrCreateCompanyLabel: (...args: unknown[]) => resolveOrCreateCompanyLabel(...args),
}));
const reconcileIfAuto = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./auto-company-subgroups.functions", () => ({
  reconcileIfAuto: (...args: unknown[]) => reconcileIfAuto(...args),
}));

import { applySuggestionImpl, runContactGroupSuggestionsImpl } from "./suggest-groups.functions";

const USER = "u1";
const ATTACKER = "attacker-user-9";
const SID = "aaaaaaaa-1111-4111-8111-111111111111";
const FOREIGN_GROUP = "bbbbbbbb-2222-4222-8222-222222222222";

/** The fake under the `DB` type these Impl helpers declare. */
const db = () => asSupabaseAdmin(fake);

function seedSuggestion(overrides: Record<string, unknown> = {}) {
  fake.seedRaw("contact_group_suggestions", [
    {
      id: SID,
      user_id: USER,
      status: "pending",
      name: "Nissan",
      parent_group_id: null,
      existing_group_id: "g1",
      contact_ids: ["c1", "c2"],
      ...overrides,
    },
  ]);
}

beforeEach(() => {
  fake.reset();
  resolveOrCreateCompanyLabel.mockClear();
  resolveOrCreateCompanyLabel.mockResolvedValue({ id: "resolved-group" });
  reconcileIfAuto.mockClear();
  generateText.mockReset();
  vi.stubEnv("LOVABLE_API_KEY", "test-key");
});

describe("applySuggestionImpl — guards", () => {
  it("rejects an unknown suggestion", async () => {
    await expect(applySuggestionImpl(db(), USER, { id: SID })).rejects.toThrow(
      "Suggestion not found",
    );
  });

  it("rejects a suggestion that is not pending", async () => {
    seedSuggestion({ status: "accepted" });
    await expect(applySuggestionImpl(db(), USER, { id: SID })).rejects.toThrow("Already handled");
  });

  it("another tenant's suggestion is not found, and nothing is written", async () => {
    seedSuggestion();
    await expect(applySuggestionImpl(db(), ATTACKER, { id: SID })).rejects.toThrow(
      "Suggestion not found",
    );
    expect(writeCount(fake)).toBe(0);
  });

  it("a client-chosen target group owned by someone else is refused before any member upsert", async () => {
    // The guard that matters: `supabase` here may be the service-role client
    // (background gate), so a foreign group_id would otherwise be written.
    seedSuggestion();
    fake.seed("contact_groups", [makeGroupRow({ id: FOREIGN_GROUP, user_id: "victim-user-2" })]);
    await expect(
      applySuggestionImpl(db(), USER, { id: SID, target_group_id: FOREIGN_GROUP }),
    ).rejects.toThrow("Target group not found");
    expect(writeCount(fake)).toBe(0);
    expect(reconcileIfAuto).not.toHaveBeenCalled();
  });

  it("a client-chosen target group the caller owns is used for the membership rows", async () => {
    seedSuggestion();
    fake.seed("contact_groups", [makeGroupRow({ id: FOREIGN_GROUP, user_id: USER })]);
    const res = await applySuggestionImpl(db(), USER, { id: SID, target_group_id: FOREIGN_GROUP });
    expect(res).toEqual({ ok: true, group_id: FOREIGN_GROUP, added: 2 });
    const upsert = fake.calls.upserts.find((u) => u.table === "contact_group_members")!;
    expect(upsert.payload).toStrictEqual([
      { user_id: USER, group_id: FOREIGN_GROUP, contact_id: "c1" },
      { user_id: USER, group_id: FOREIGN_GROUP, contact_id: "c2" },
    ]);
  });
});

describe("applySuggestionImpl — apply onto an existing label", () => {
  it("adds members to the suggestion's existing group and marks it accepted", async () => {
    seedSuggestion();

    const res = await applySuggestionImpl(db(), USER, { id: SID });
    expect(res).toEqual({ ok: true, group_id: "g1", added: 2 });

    // No label resolution needed when the suggestion already targets a group.
    expect(resolveOrCreateCompanyLabel).not.toHaveBeenCalled();

    const upsert = fake.calls.upserts.find((u) => u.table === "contact_group_members");
    const rows = upsert?.payload as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.contact_id)).toEqual(["c1", "c2"]);
    expect(rows.every((r) => r.group_id === "g1")).toBe(true);

    const upd = fake.calls.updates.find((u) => u.table === "contact_group_suggestions");
    expect(upd?.payload).toMatchObject({ status: "accepted" });
    expect(upd?.filters).toStrictEqual([
      { op: "eq", col: "id", value: SID, extra: undefined },
      { op: "eq", col: "user_id", value: USER, extra: undefined },
    ]);
    expect(reconcileIfAuto).toHaveBeenCalledWith(expect.anything(), USER, "g1");
  });

  it("the background gate records auto_applied and its evidence", async () => {
    seedSuggestion();
    await applySuggestionImpl(db(), USER, {
      id: SID,
      autoApplied: true,
      evidence: { rule: "same_domain" },
    });
    const upd = fake.calls.updates.find((u) => u.table === "contact_group_suggestions");
    expect(upd?.payload).toStrictEqual({
      status: "accepted",
      auto_applied: true,
      evidence: { rule: "same_domain" },
    });
  });
});

describe("applySuggestionImpl — resolve a new label", () => {
  it("resolves/creates a label when the suggestion has no target group", async () => {
    seedSuggestion({ existing_group_id: null, contact_ids: ["c1"] });

    const res = await applySuggestionImpl(db(), USER, { id: SID });
    expect(res).toEqual({ ok: true, group_id: "resolved-group", added: 1 });
    expect(resolveOrCreateCompanyLabel).toHaveBeenCalled();

    const upsert = fake.calls.upserts.find((u) => u.table === "contact_group_members");
    expect((upsert?.payload as Array<Record<string, unknown>>)[0]!.group_id).toBe("resolved-group");
  });
});

describe("applySuggestionImpl — fail-recovery", () => {
  it("does not mark the suggestion accepted when the membership write fails", async () => {
    seedSuggestion();
    fake.onUpsert("contact_group_members", () => ({ message: "member write boom" }));

    await expect(applySuggestionImpl(db(), USER, { id: SID })).rejects.toThrow("member write boom");

    // The suggestion stays pending — no status flip to "accepted".
    expect(fake.calls.updates.filter((u) => u.table === "contact_group_suggestions")).toHaveLength(
      0,
    );
  });
});

describe("runContactGroupSuggestionsImpl", () => {
  function seedContacts() {
    fake.seed("contacts", [
      makeContactRow({ id: "c1", user_id: USER, email: "a@acme.com", company: "Acme" }),
      makeContactRow({ id: "c2", user_id: USER, email: "b@acme.com", company: "Acme" }),
      makeContactRow({ id: "c3", user_id: USER, email: "c@globex.io", company: "Globex" }),
      makeContactRow({ id: "foreign", user_id: "victim-user-2", email: "v@evil.test" }),
    ]);
  }

  it("writes the model's clusters as pending suggestions owned by the caller", async () => {
    seedContacts();
    generateText.mockResolvedValue({
      output: {
        suggestions: [
          {
            name: "Acme",
            kind: "new",
            contact_ids: [1, 2],
            rationale: "Same company",
            confidence: "high",
          },
        ],
      },
    });

    const res = (await runContactGroupSuggestionsImpl(db(), USER)) as {
      stats?: { kept: number; parsed: number };
    };
    expect(res.stats).toMatchObject({ parsed: 1, kept: 1 });
    const ins = fake.calls.inserts.find((i) => i.table === "contact_group_suggestions")!;
    const rows = ins.payload as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: USER,
      name: "Acme",
      kind: "new",
      status: "pending",
      confidence: "high",
      rationale: "Same company",
      parent_group_id: null,
      existing_group_id: null,
    });
    // Short indices were mapped back to real contact uuids.
    expect((rows[0] as { contact_ids: string[] }).contact_ids).toHaveLength(2);
  });

  it("drops invented indices and clusters that fall under two members", async () => {
    seedContacts();
    generateText.mockResolvedValue({
      output: {
        suggestions: [
          { name: "Ghosts", kind: "new", contact_ids: [99, 100], confidence: "low" },
          { name: "Solo", kind: "new", contact_ids: [1], confidence: "low" },
        ],
      },
    });
    const res = (await runContactGroupSuggestionsImpl(db(), USER)) as {
      stats?: { kept: number; droppedMissingIds: number; droppedTooSmall: number };
    };
    expect(res.stats).toMatchObject({ kept: 0, droppedMissingIds: 2, droppedTooSmall: 2 });
    expect(fake.calls.inserts).toHaveLength(0);
  });

  it("an account with no contacts makes no model call", async () => {
    const res = await runContactGroupSuggestionsImpl(db(), USER);
    expect(res).toStrictEqual({ suggestions: [] });
    expect(generateText).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("inside the rescan cooldown it returns the cached run without calling the model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    seedContacts();
    fake.seedRaw("contact_group_suggestions", [
      {
        id: SID,
        user_id: USER,
        run_id: "run-1",
        name: "Acme",
        status: "pending",
        contact_ids: ["c1", "c2"],
        kind: "new",
        created_at: "2026-03-01T11:58:00Z",
        confidence: "high",
        rationale: null,
        parent_group_id: null,
        existing_group_id: null,
        auto_applied: false,
      },
    ]);
    const res = (await runContactGroupSuggestionsImpl(db(), USER)) as {
      stats?: { cached?: boolean; cooldownRemainingSeconds?: number };
    };
    expect(res.stats).toMatchObject({ cached: true, cooldownRemainingSeconds: 180 });
    expect(generateText).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
    vi.useRealTimers();
  });

  it("the background source errors inside the cooldown instead of returning a cached run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    fake.seedRaw("contact_group_suggestions", [
      { id: SID, user_id: USER, created_at: "2026-03-01T11:58:00Z", status: "pending" },
    ]);
    await expect(
      runContactGroupSuggestionsImpl(db(), USER, { source: "background" }),
    ).rejects.toThrow("Please wait 180s");
    vi.useRealTimers();
  });

  it("a missing LOVABLE_API_KEY throws before the contacts read", async () => {
    vi.stubEnv("LOVABLE_API_KEY", undefined);
    await expect(runContactGroupSuggestionsImpl(db(), USER)).rejects.toThrow(
      "Missing LOVABLE_API_KEY",
    );
  });
});
