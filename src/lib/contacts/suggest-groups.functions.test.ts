// Tests for applySuggestionImpl (src/lib/contacts/suggest-groups.functions.ts) —
// the path that turns an accepted AI group suggestion into real memberships.
// Focus: status guards, the existing-vs-resolved target-label branch, and the
// fail-recovery invariant that a suggestion is NOT marked accepted when the
// membership write fails.

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
  supabaseAdmin: { from: (t: string) => fake.supabaseAdmin.from(t) },
}));
vi.mock("@/lib/log.server", () => ({ logInfo: vi.fn() }));
vi.mock("@/lib/sync/encrypted-reader", () => ({
  getEmailsDecrypted: vi.fn(),
  searchEmailsParticipantsDecrypted: vi.fn(),
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

import { applySuggestionImpl } from "./suggest-groups.functions";

const USER = "u1";
const SID = "aaaaaaaa-1111-4111-8111-111111111111";

function seedSuggestion(overrides: Record<string, unknown> = {}) {
  fake.seed("contact_group_suggestions", [
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
});

describe("applySuggestionImpl — guards", () => {
  it("rejects an unknown suggestion", async () => {
    await expect(
      applySuggestionImpl(fake.supabaseAdmin as never, USER, { id: SID }),
    ).rejects.toThrow("Suggestion not found");
  });

  it("rejects a suggestion that is not pending", async () => {
    seedSuggestion({ status: "accepted" });
    await expect(
      applySuggestionImpl(fake.supabaseAdmin as never, USER, { id: SID }),
    ).rejects.toThrow("Already handled");
  });
});

describe("applySuggestionImpl — apply onto an existing label", () => {
  it("adds members to the suggestion's existing group and marks it accepted", async () => {
    seedSuggestion();

    const res = await applySuggestionImpl(fake.supabaseAdmin as never, USER, { id: SID });
    expect(res).toEqual({ ok: true, group_id: "g1", added: 2 });

    // No label resolution needed when the suggestion already targets a group.
    expect(resolveOrCreateCompanyLabel).not.toHaveBeenCalled();

    const upsert = fake.calls.upserts.find((u) => u.table === "contact_group_members");
    const rows = upsert?.payload as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.contact_id)).toEqual(["c1", "c2"]);
    expect(rows.every((r) => r.group_id === "g1")).toBe(true);

    const upd = fake.calls.updates.find((u) => u.table === "contact_group_suggestions");
    expect(upd?.payload).toMatchObject({ status: "accepted" });
    expect(reconcileIfAuto).toHaveBeenCalledWith(expect.anything(), USER, "g1");
  });
});

describe("applySuggestionImpl — resolve a new label", () => {
  it("resolves/creates a label when the suggestion has no target group", async () => {
    seedSuggestion({ existing_group_id: null, contact_ids: ["c1"] });

    const res = await applySuggestionImpl(fake.supabaseAdmin as never, USER, { id: SID });
    expect(res).toEqual({ ok: true, group_id: "resolved-group", added: 1 });
    expect(resolveOrCreateCompanyLabel).toHaveBeenCalled();

    const upsert = fake.calls.upserts.find((u) => u.table === "contact_group_members");
    expect((upsert?.payload as Array<Record<string, unknown>>)[0].group_id).toBe("resolved-group");
  });
});

describe("applySuggestionImpl — fail-recovery", () => {
  it("does not mark the suggestion accepted when the membership write fails", async () => {
    seedSuggestion();
    fake.onUpsert("contact_group_members", () => ({ message: "member write boom" }));

    await expect(
      applySuggestionImpl(fake.supabaseAdmin as never, USER, { id: SID }),
    ).rejects.toThrow("member write boom");

    // The suggestion stays pending — no status flip to "accepted".
    expect(fake.calls.updates.filter((u) => u.table === "contact_group_suggestions")).toHaveLength(
      0,
    );
  });
});
