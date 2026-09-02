// Destructive half of src/lib/companies/companies.functions.ts: the merge
// pipeline (`mergeCompanies`, `mergeCluster`), `deleteCompany`, and the
// duplicate detector that feeds them (`findDuplicateCompanies`).
//
// The fake runs with `applyWrites: true` so `mergeCompaniesImpl`'s
// read-after-delete verify sees the real post-delete state and a full happy
// path is observable end to end.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  makeSupabaseFake,
  mockSupabaseAdmin,
  writeCount,
  writesTo,
} from "@/lib/__fixtures__/supabase-fake";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";

const fake = makeSupabaseFake({ applyWrites: true });

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
vi.mock("./resolve.server", () => ({
  findOrCreateCompanyByName: vi.fn(),
  resolveContactCompany: vi.fn(),
}));

const generateText = vi.hoisted(() => vi.fn<(args: unknown) => Promise<unknown>>());
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    generateText: (args: unknown) => generateText(args),
    Output: { object: (o: unknown) => o },
    NoObjectGeneratedError: actual.NoObjectGeneratedError,
  };
});
vi.mock("@/lib/ai-gateway", () => ({ getModel: () => ({ modelId: "test-model" }) }));

const reconcileAutoParentsForContacts = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<void>>(),
);
vi.mock("@/lib/contacts/auto-company-subgroups.functions", () => ({
  reconcileAutoParentsForContacts: (...args: unknown[]) => reconcileAutoParentsForContacts(...args),
}));
const syncCompanyRuleMemberships = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
vi.mock("@/lib/contacts/group-rules.functions", () => ({
  syncCompanyRuleMemberships: (...args: unknown[]) => syncCompanyRuleMemberships(...args),
}));

import {
  mergeCompanies,
  mergeCluster,
  deleteCompany,
  findDuplicateCompanies,
} from "./companies.functions";

const USER = TEST_USER;
const ATTACKER = "attacker-user-9";
const VICTIM = "victim-user-7";
const TARGET = "aaaaaaaa-1111-4111-8111-111111111111";
const SOURCE = "bbbbbbbb-2222-4222-8222-222222222222";
const COMPANY = "cccccccc-3333-4333-8333-333333333333";

const ctx = { context: { supabase: fake.supabaseAdmin } };
const asAttacker = { context: { supabase: fake.supabaseAdmin, userId: ATTACKER } };

const NOW = "2026-05-01T12:00:00.000Z";

beforeEach(() => {
  fake.reset();
  reconcileAutoParentsForContacts.mockResolvedValue(undefined);
  syncCompanyRuleMemberships.mockResolvedValue(undefined);
  generateText.mockReset();
  vi.stubEnv("LOVABLE_API_KEY", undefined);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* mergeCompanies                                                              */
/* -------------------------------------------------------------------------- */

/** Both companies plus every satellite row the merge has to re-key. */
function seedMergeableCompanies() {
  fake.seed("companies", [
    { id: TARGET, user_id: USER, name: "Target Co", name_key: "target co" },
    { id: SOURCE, user_id: USER, name: "Source Co", name_key: "source co" },
  ]);
  fake.seed("contacts", [
    { id: "k1", user_id: USER, company_id: SOURCE, company: "Source Co" },
    { id: "k2", user_id: USER, company_id: SOURCE, company: "Source Co" },
    // Free-text reference with no FK — picked up by the alias sweep.
    { id: "stray", user_id: USER, company_id: null, company: "Source Co" },
    // Another tenant's row that names the same company must not move.
    { id: "foreign", user_id: VICTIM, company_id: null, company: "Source Co" },
  ]);
  fake.seed("company_domains", [
    { id: "d1", user_id: USER, company_id: SOURCE, domain: "source.test", source: "manual" },
    { id: "d2", user_id: USER, company_id: TARGET, domain: "target.test", source: "auto" },
  ]);
  fake.seed("company_tags", [{ id: "t1", user_id: USER, company_id: SOURCE, tag: "vip" }]);
  fake.seed("company_logo_hashes", [
    {
      id: "h1",
      user_id: USER,
      company_id: SOURCE,
      domain: "source.test",
      sha256: "abc",
      source: "clearbit",
    },
  ]);
  fake.seed("company_name_aliases", [
    {
      user_id: USER,
      company_id: SOURCE,
      name_key: "old source",
      source_name: "Old Source",
    },
  ]);
  fake.seed("contact_group_rules", [
    { id: "r1", user_id: USER, group_id: "g1", rule_type: "company_id", value: SOURCE },
  ]);
}

describe("mergeCompanies", () => {
  it("denies a cross-user target company and writes nothing", async () => {
    fake.seed("companies", [
      { id: TARGET, user_id: VICTIM, name: "Victim Co" },
      { id: SOURCE, user_id: ATTACKER, name: "Attacker Co" },
    ]);
    await expectDeniedCrossUser({
      fake,
      call: () => mergeCompanies({ data: { sourceId: SOURCE, targetId: TARGET }, ...asAttacker }),
      rejects: "Target company not found",
    });
  });

  it("rejects merging a company into itself before touching the database", async () => {
    await expect(
      mergeCompanies({ data: { sourceId: TARGET, targetId: TARGET }, ...ctx }),
    ).rejects.toThrow("Cannot merge a company into itself");
    expect(fake.calls.selects).toHaveLength(0);
    expect(writeCount(fake)).toBe(0);
  });

  it("moves contacts, re-keys satellites, records aliases and deletes the source last", async () => {
    seedMergeableCompanies();

    const res = await mergeCompanies({ data: { sourceId: SOURCE, targetId: TARGET }, ...ctx });
    expect(res).toStrictEqual({ ok: true, movedContacts: 3 });

    // Contacts: both FK-linked rows plus the free-text stray now point at the
    // target and carry its name; the other tenant's row is untouched.
    expect(fake.rows("contacts")).toStrictEqual([
      { id: "k1", user_id: USER, company_id: TARGET, company: "Target Co" },
      { id: "k2", user_id: USER, company_id: TARGET, company: "Target Co" },
      { id: "stray", user_id: USER, company_id: TARGET, company: "Target Co" },
      { id: "foreign", user_id: VICTIM, company_id: null, company: "Source Co" },
    ]);

    // Domains / tags / logo hashes are re-keyed onto the target.
    expect(fake.rows("company_domains")).toStrictEqual([
      { id: "d2", user_id: USER, company_id: TARGET, domain: "target.test", source: "auto" },
      { user_id: USER, company_id: TARGET, domain: "source.test", source: "manual" },
    ]);
    expect(fake.rows("company_tags")).toStrictEqual([
      { user_id: USER, company_id: TARGET, tag: "vip" },
    ]);
    expect(fake.rows("company_logo_hashes")).toStrictEqual([
      {
        user_id: USER,
        company_id: TARGET,
        domain: "source.test",
        sha256: "abc",
        source: "clearbit",
        last_seen_at: NOW,
      },
    ]);

    // The source name and its own aliases become aliases of the target.
    expect(writesTo(fake, "upserts", "company_name_aliases")).toHaveLength(1);
    expect(writesTo(fake, "upserts", "company_name_aliases")[0]!.payload).toStrictEqual([
      { user_id: USER, name_key: "source co", company_id: TARGET, source_name: "Source Co" },
      { user_id: USER, name_key: "old source", company_id: TARGET, source_name: "Old Source" },
    ]);

    // Company-in-label rules follow the survivor.
    expect(fake.rows("contact_group_rules")).toStrictEqual([
      { id: "r1", user_id: USER, group_id: "g1", rule_type: "company_id", value: TARGET },
    ]);

    // Only the source company row is gone.
    expect(fake.rows("companies").map((c) => c.id)).toStrictEqual([TARGET]);

    // Every write carries the caller's user_id, in the payload or a filter.
    const allWrites = [
      ...fake.calls.inserts,
      ...fake.calls.updates,
      ...fake.calls.upserts,
      ...fake.calls.deletes,
    ];
    for (const w of allWrites) {
      const rows = Array.isArray(w.payload) ? w.payload : [w.payload];
      const inPayload = rows.some(
        (r) => r && typeof r === "object" && (r as { user_id?: string }).user_id === USER,
      );
      const inFilters = w.filters.some((f) => f.col === "user_id" && f.value === USER);
      // The rule re-point is filtered by the rule id, which was itself read
      // under `user_id = caller`.
      const isRulePoint =
        w.table === "contact_group_rules" && w.filters.some((f) => f.col === "id");
      expect(
        inPayload || inFilters || isRulePoint,
        `${w.table} write must be scoped to the caller`,
      ).toBe(true);
    }

    // The irreversible source delete happens after every re-key.
    const companyDelete = fake.calls.deletes.findIndex((d) => d.table === "companies");
    expect(companyDelete).toBe(fake.calls.deletes.length - 1);
    expect(fake.calls.deletes[companyDelete]!.filters).toStrictEqual([
      { op: "eq", col: "id", value: SOURCE, extra: undefined },
      { op: "eq", col: "user_id", value: USER, extra: undefined },
    ]);

    expect(reconcileAutoParentsForContacts).toHaveBeenCalledWith(fake.supabaseAdmin, USER, [
      "k1",
      "k2",
      "stray",
    ]);
    expect(syncCompanyRuleMemberships).toHaveBeenCalledWith(fake.supabaseAdmin, USER, {
      companyIds: [TARGET],
      contactIds: ["k1", "k2", "stray"],
      bumpResync: true,
    });
  });

  it("aborts before deleting the source company when moving domains fails", async () => {
    seedMergeableCompanies();
    fake.onDelete("company_domains", () => ({ message: "domain move boom" }));

    await expect(
      mergeCompanies({ data: { sourceId: SOURCE, targetId: TARGET }, ...ctx }),
    ).rejects.toThrow("domain move boom");

    expect(writesTo(fake, "deletes", "companies")).toHaveLength(0);
    expect(fake.rows("companies").map((c) => c.id)).toStrictEqual([TARGET, SOURCE]);
  });

  it("reports failure when the source company survives the delete", async () => {
    seedMergeableCompanies();
    const survivors = fake.rows("companies");
    // A policy silently swallows the delete: every read of `companies` keeps
    // seeing both rows, including the post-delete verify.
    fake.onSelect("companies", () => ({ data: survivors }));

    await expect(
      mergeCompanies({ data: { sourceId: SOURCE, targetId: TARGET }, ...ctx }),
    ).rejects.toThrow(`Merge did not delete source company (id=${SOURCE})`);
  });

  it("moves nothing and leaves the victim's rows intact for a foreign source id", async () => {
    fake.seed("companies", [
      { id: TARGET, user_id: ATTACKER, name: "Attacker Co", name_key: "attacker co" },
      { id: SOURCE, user_id: VICTIM, name: "Victim Co", name_key: "victim co" },
    ]);
    fake.seed("contacts", [
      { id: "v1", user_id: VICTIM, company_id: SOURCE, company: "Victim Co" },
    ]);
    fake.seed("company_domains", [
      { id: "vd", user_id: VICTIM, company_id: SOURCE, domain: "victim.test", source: "manual" },
    ]);

    const res = await mergeCompanies({
      data: { sourceId: SOURCE, targetId: TARGET },
      ...asAttacker,
    });

    expect(res).toStrictEqual({ ok: true, movedContacts: 0 });
    expect(fake.rows("contacts")).toStrictEqual([
      { id: "v1", user_id: VICTIM, company_id: SOURCE, company: "Victim Co" },
    ]);
    expect(fake.rows("company_domains")).toHaveLength(1);
    expect(
      fake
        .rows("companies")
        .map((c) => c.id)
        .sort(),
    ).toStrictEqual([TARGET, SOURCE].sort());
  });
});

/* -------------------------------------------------------------------------- */
/* mergeCluster                                                                */
/* -------------------------------------------------------------------------- */

describe("mergeCluster", () => {
  it("skips the canonical id and sums the contacts moved by each fold", async () => {
    const OTHER = "dddddddd-4444-4444-8444-444444444444";
    fake.seed("companies", [
      { id: TARGET, user_id: USER, name: "Target Co", name_key: "target co" },
      { id: SOURCE, user_id: USER, name: "Source Co", name_key: "source co" },
      { id: OTHER, user_id: USER, name: "Other Co", name_key: "other co" },
    ]);
    fake.seed("contacts", [
      { id: "k1", user_id: USER, company_id: SOURCE, company: "Source Co" },
      { id: "k2", user_id: USER, company_id: OTHER, company: "Other Co" },
    ]);

    const res = await mergeCluster({
      data: { canonicalId: TARGET, foldIds: [TARGET, SOURCE, OTHER] },
      ...ctx,
    });

    expect(res).toStrictEqual({ merged: 2, failed: 0, movedContacts: 2, errors: [] });
    expect(fake.rows("companies").map((c) => c.id)).toStrictEqual([TARGET]);
  });

  it("records a per-source error and still reports the folds that worked", async () => {
    const OTHER = "dddddddd-4444-4444-8444-444444444444";
    fake.seed("companies", [
      { id: TARGET, user_id: USER, name: "Target Co", name_key: "target co" },
      { id: SOURCE, user_id: USER, name: "Source Co", name_key: "source co" },
      { id: OTHER, user_id: USER, name: "Other Co", name_key: "other co" },
    ]);
    fake.seed("contacts", [{ id: "k1", user_id: USER, company_id: SOURCE, company: "Source Co" }]);
    fake.seed("company_tags", [{ id: "t1", user_id: USER, company_id: OTHER, tag: "vip" }]);
    fake.onDelete("company_tags", () => ({ message: "tag move boom" }));

    const res = await mergeCluster({
      data: { canonicalId: TARGET, foldIds: [SOURCE, OTHER] },
      ...ctx,
    });

    expect(res).toStrictEqual({
      merged: 1,
      failed: 1,
      movedContacts: 1,
      errors: [{ sourceId: OTHER, message: "tag move boom" }],
    });
    // The failed fold's company row survives so the state stays recoverable.
    expect(fake.rows("companies").map((c) => c.id)).toStrictEqual([TARGET, OTHER]);
  });

  it("throws with the first error when every fold failed", async () => {
    fake.seed("companies", [{ id: SOURCE, user_id: USER, name: "Source Co" }]);
    // Target belongs to nobody the caller can see.
    await expect(
      mergeCluster({ data: { canonicalId: TARGET, foldIds: [SOURCE] }, ...ctx }),
    ).rejects.toThrow("Merge failed: Target company not found");
    expect(writeCount(fake)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* deleteCompany                                                               */
/* -------------------------------------------------------------------------- */

describe("deleteCompany", () => {
  it("captures affected contacts, removes company-id rules, deletes the company and reconciles", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Doomed" }]);
    fake.seed("contacts", [
      { id: "k1", user_id: USER, company_id: COMPANY },
      { id: "k2", user_id: USER, company_id: COMPANY },
      { id: "other", user_id: USER, company_id: TARGET },
    ]);
    fake.seed("contact_group_rules", [
      { id: "r1", user_id: USER, group_id: "g1", rule_type: "company_id", value: COMPANY },
      { id: "r2", user_id: USER, group_id: "g1", rule_type: "company_id", value: TARGET },
    ]);

    const res = await deleteCompany({ data: { id: COMPANY }, ...ctx });
    expect(res).toStrictEqual({ ok: true });

    expect(fake.rows("contact_group_rules").map((r) => r.id)).toStrictEqual(["r2"]);
    expect(fake.rows("companies")).toStrictEqual([]);
    expect(reconcileAutoParentsForContacts).toHaveBeenCalledWith(fake.supabaseAdmin, USER, [
      "k1",
      "k2",
    ]);
    expect(syncCompanyRuleMemberships).toHaveBeenCalledWith(fake.supabaseAdmin, USER, {
      contactIds: ["k1", "k2"],
      bumpResync: true,
    });
  });

  it("leaves another user's company and its rules untouched", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: VICTIM, name: "Victim Co" }]);
    fake.seed("contacts", [{ id: "v1", user_id: VICTIM, company_id: COMPANY }]);
    fake.seed("contact_group_rules", [
      { id: "r1", user_id: VICTIM, group_id: "g1", rule_type: "company_id", value: COMPANY },
    ]);

    // Every write is filtered by `user_id = caller`, so the call is a no-op
    // rather than a rejection.
    await expect(deleteCompany({ data: { id: COMPANY }, ...asAttacker })).resolves.toStrictEqual({
      ok: true,
    });

    expect(fake.rows("companies")).toHaveLength(1);
    expect(fake.rows("contact_group_rules")).toHaveLength(1);
    expect(reconcileAutoParentsForContacts).not.toHaveBeenCalled();
  });

  it("swallows a syncCompanyRuleMemberships failure and still succeeds", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Doomed" }]);
    fake.seed("contacts", [{ id: "k1", user_id: USER, company_id: COMPANY }]);
    syncCompanyRuleMemberships.mockRejectedValueOnce(new Error("membership sync boom"));

    await expect(deleteCompany({ data: { id: COMPANY }, ...ctx })).resolves.toStrictEqual({
      ok: true,
    });
    expect(fake.rows("companies")).toStrictEqual([]);
  });

  it("propagates a hard failure to delete the company row", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Doomed" }]);
    fake.onDelete("companies", () => ({ message: "delete blocked" }));
    await expect(deleteCompany({ data: { id: COMPANY }, ...ctx })).rejects.toThrow(
      "delete blocked",
    );
    expect(reconcileAutoParentsForContacts).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* findDuplicateCompanies                                                      */
/* -------------------------------------------------------------------------- */

const HONDA = "eeeeeeee-5555-4555-8555-555555555555";
const AM_HONDA = "ffffffff-6666-4666-8666-666666666666";
const DEALER = "99999999-7777-4777-8777-777777777777";

function seedHondaCluster() {
  fake.seed("companies", [
    { id: HONDA, user_id: USER, name: "Honda" },
    { id: AM_HONDA, user_id: USER, name: "American Honda" },
    { id: DEALER, user_id: USER, name: "Honda Of Boston" },
    // Another tenant's duplicates must never be clustered with the caller's.
    { id: TARGET, user_id: VICTIM, name: "Honda" },
  ]);
}

describe("findDuplicateCompanies", () => {
  it("returns nothing and never queries satellites when the user has fewer than two companies", async () => {
    fake.seed("companies", [{ id: HONDA, user_id: USER, name: "Honda" }]);

    const res = await findDuplicateCompanies({ data: {}, ...ctx });

    expect(res).toStrictEqual({ clusters: [], aiUsed: false, aiError: null });
    expect(fake.calls.selects.map((s) => s.table)).toStrictEqual(["companies"]);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("clusters only the caller's companies and pre-checks brand-equal members", async () => {
    seedHondaCluster();

    const res = await findDuplicateCompanies({ data: {}, ...ctx });

    expect(res.aiUsed).toBe(false);
    expect(res.aiError).toBeNull();
    expect(res.clusters).toHaveLength(1);
    const cluster = res.clusters[0]!;
    expect(cluster.canonicalId).toBe(HONDA);
    expect(cluster.canonicalName).toBe("Honda");
    expect(cluster.rationale).toBe("Grouped by shared brand token / domain root.");
    expect(cluster.members).toStrictEqual([
      { id: HONDA, name: "Honda", member_count: 0, domains: [], include: false },
      // "American Honda" keys to the same brand → folded by default.
      { id: AM_HONDA, name: "American Honda", member_count: 0, domains: [], include: true },
      // A dealer merely shares the brand token → left unchecked.
      { id: DEALER, name: "Honda Of Boston", member_count: 0, domains: [], include: false },
    ]);
    expect(generateText).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("reports a missing API key instead of calling the model", async () => {
    seedHondaCluster();

    const res = await findDuplicateCompanies({ data: { useAi: true }, ...ctx });

    expect(res.aiUsed).toBe(false);
    expect(res.aiError).toBe("Missing LOVABLE_API_KEY");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("sends every cluster in one model call and applies its keep/fold verdict", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "k");
    seedHondaCluster();
    generateText.mockResolvedValue({
      output: {
        clusters: [
          {
            canonicalName: "Honda",
            fold: ["Honda Of Boston"],
            keep: ["American Honda"],
            rationale: "Dealer rolls up; the distributor is its own relationship.",
          },
        ],
      },
    });

    const res = await findDuplicateCompanies({ data: { useAi: true }, ...ctx });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(res.aiUsed).toBe(true);
    expect(res.aiError).toBeNull();
    expect(res.clusters[0]!.rationale).toBe(
      "Dealer rolls up; the distributor is its own relationship.",
    );
    expect(res.clusters[0]!.members.map((m) => [m.name, m.include])).toStrictEqual([
      ["Honda", false],
      ["American Honda", false],
      ["Honda Of Boston", true],
    ]);
  });

  it("falls back to the heuristic clustering when the model returns unparseable output", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "k");
    seedHondaCluster();
    const { NoObjectGeneratedError } = await vi.importActual<typeof import("ai")>("ai");
    generateText.mockRejectedValue(
      new NoObjectGeneratedError({
        message: "no object",
        response: { id: "resp-1", timestamp: new Date(NOW), modelId: "test-model" },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          inputTokenDetails: {
            noCacheTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
        },
        finishReason: "stop",
      }),
    );

    const res = await findDuplicateCompanies({ data: { useAi: true }, ...ctx });

    expect(res.aiUsed).toBe(false);
    expect(res.aiError).toBe("AI returned an unparseable response");
    expect(res.clusters[0]!.members.map((m) => m.include)).toStrictEqual([false, true, false]);
    expect(res.clusters[0]!.rationale).toBe("Grouped by shared brand token / domain root.");
  });

  it("surfaces any other model failure while still returning the heuristic clusters", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "k");
    seedHondaCluster();
    generateText.mockRejectedValue(new Error("gateway 503"));

    const res = await findDuplicateCompanies({ data: { useAi: true }, ...ctx });

    expect(res.aiUsed).toBe(false);
    expect(res.aiError).toBe("gateway 503");
    expect(res.clusters).toHaveLength(1);
  });
});
