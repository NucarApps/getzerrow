// Tests for the company dedup/merge logic (src/lib/companies/companies.functions.ts).
//
// Two layers are covered:
//   1. The pure brand-clustering core (`tokenize` + `clusterCompanies`) — the
//      "American Honda" / "nissan-usa.com" union-find logic. No DB.
//   2. The destructive server fns (`mergeCompanies`, `deleteCompany`) via the
//      shared Supabase fake, focusing on input guards and the documented
//      fail-recovery invariant: mergeCompaniesImpl error-checks every write and
//      throws BEFORE the irreversible source-company delete.
//
// NOTE on the fake: recorded writes do not mutate seeded rows, so the
// read-after-delete *verify* in mergeCompaniesImpl would falsely fire on a full
// happy path. We therefore assert merge behaviour on the paths that stop before
// (or never reach) that verify, and cover the delete side via deleteCompany,
// which has no read-after-delete.

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
// Company resolution is unrelated to these paths; stub to keep the import light.
vi.mock("./resolve.server", () => ({ findOrCreateCompanyByName: vi.fn() }));

// Best-effort post-merge/-delete side effects — stubbed and asserted.
const reconcileAutoParentsForContacts = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/contacts/auto-company-subgroups.functions", () => ({
  reconcileAutoParentsForContacts: (...args: unknown[]) => reconcileAutoParentsForContacts(...args),
}));
const syncCompanyRuleMemberships = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/contacts/group-rules.functions", () => ({
  syncCompanyRuleMemberships: (...args: unknown[]) => syncCompanyRuleMemberships(...args),
}));

import {
  tokenize,
  clusterCompanies,
  mergeCompanies,
  deleteCompany,
  type CompanyLite,
} from "./companies.functions";

const USER = "test-user-1";

function co(id: string, name: string, domains: string[] = [], member_count = 0): CompanyLite {
  return { id, name, member_count, domains };
}

beforeEach(() => {
  fake.reset();
  reconcileAutoParentsForContacts.mockClear();
  syncCompanyRuleMemberships.mockClear();
  syncCompanyRuleMemberships.mockImplementation(async () => {});
});

/* -------------------------------------------------------------------------- */
/* tokenize                                                                    */
/* -------------------------------------------------------------------------- */

describe("tokenize", () => {
  it("drops stopword brand qualifiers (American → dropped, Honda kept)", () => {
    expect(tokenize("American Honda")).toEqual(["honda"]);
  });

  it("strips legal suffixes and drops sub-3-char tokens", () => {
    // "AB Corp" → normalize strips " corp" → "ab" → 2 chars → filtered out.
    expect(tokenize("AB Corp")).toEqual([]);
  });

  it("keeps multiple distinctive tokens, dropping the 'company' stopword", () => {
    expect(tokenize("Nissan Motor Acceptance Company")).toEqual(["nissan", "motor", "acceptance"]);
  });
});

/* -------------------------------------------------------------------------- */
/* clusterCompanies                                                            */
/* -------------------------------------------------------------------------- */

describe("clusterCompanies", () => {
  it("unites companies that share a distinctive brand token", () => {
    const clusters = clusterCompanies([
      co("a", "American Honda"),
      co("b", "Honda of Boston"),
      co("c", "Toyota Financial"),
    ]);
    expect(clusters).toHaveLength(1);
    const ids = clusters[0].map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("does NOT unite companies whose only shared token is a stopword", () => {
    // "Alpha Group" → ["alpha"], "Beta Group" → ["beta"] (group is a stopword).
    const clusters = clusterCompanies([co("x", "Alpha Group"), co("y", "Beta Group")]);
    expect(clusters).toEqual([]);
  });

  it("unites on a shared root email/site domain even when names differ", () => {
    const clusters = clusterCompanies([
      co("n1", "Nissan North America", ["nissanusa.com"]),
      co("n2", "NMAC", ["mail.nissanusa.com"]),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].map((c) => c.id).sort()).toEqual(["n1", "n2"]);
  });

  it("excludes singletons — a cluster needs at least two companies", () => {
    expect(clusterCompanies([co("solo", "Honda")])).toEqual([]);
  });

  it("ignores sub-3-char tokens when forming clusters", () => {
    // Both normalize to the 2-char token "ab", which is below the length floor.
    expect(clusterCompanies([co("p", "AB Corp"), co("q", "AB Inc")])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* mergeCompanies — guards & fail-recovery                                     */
/* -------------------------------------------------------------------------- */

const TARGET = "aaaaaaaa-1111-4111-8111-111111111111";
const SOURCE = "bbbbbbbb-2222-4222-8222-222222222222";
const ctx = { context: { supabase: fake.supabaseAdmin } };

describe("mergeCompanies — guards", () => {
  it("rejects merging a company into itself (validator)", async () => {
    await expect(
      mergeCompanies({ data: { sourceId: TARGET, targetId: TARGET }, ...ctx }),
    ).rejects.toThrow("Cannot merge a company into itself");
  });

  it("rejects when the target company does not exist", async () => {
    // companies table empty → target lookup returns null.
    await expect(
      mergeCompanies({ data: { sourceId: SOURCE, targetId: TARGET }, ...ctx }),
    ).rejects.toThrow("Target company not found");
  });
});

describe("mergeCompanies — fail-recovery ordering", () => {
  it("aborts before deleting the source company when moving domains fails", async () => {
    fake.seed("companies", [{ id: TARGET, name: "Target", user_id: USER }]);
    fake.seed("company_domains", [
      { company_id: SOURCE, domain: "x.com", source: "email", user_id: USER },
    ]);
    // The domain-move delete fails mid-merge.
    fake.onDelete("company_domains", () => ({ message: "domain move boom" }));

    await expect(
      mergeCompanies({ data: { sourceId: SOURCE, targetId: TARGET }, ...ctx }),
    ).rejects.toThrow("domain move boom");

    // The source company must NOT have been deleted — state stays recoverable.
    expect(fake.calls.deletes.filter((d) => d.table === "companies")).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* deleteCompany                                                               */
/* -------------------------------------------------------------------------- */

const COMPANY = "cccccccc-3333-4333-8333-333333333333";

describe("deleteCompany", () => {
  it("captures affected contacts, removes company-id rules, deletes the company and reconciles", async () => {
    fake.seed("contacts", [
      { id: "k1", user_id: USER, company_id: COMPANY },
      { id: "k2", user_id: USER, company_id: COMPANY },
      { id: "other", user_id: USER, company_id: "different" },
    ]);

    const res = await deleteCompany({ data: { id: COMPANY }, ...ctx });
    expect(res).toEqual({ ok: true });

    // Company-in-label rules for this company are removed (text value, no FK).
    const ruleDel = fake.calls.deletes.find((d) => d.table === "contact_group_rules");
    expect(ruleDel?.filters).toContainEqual({ op: "eq", col: "value", value: COMPANY });

    // The company row is deleted.
    const compDel = fake.calls.deletes.find((d) => d.table === "companies");
    expect(compDel?.filters).toContainEqual({ op: "eq", col: "id", value: COMPANY });

    // Affected contacts (captured before delete) are reconciled.
    expect(reconcileAutoParentsForContacts).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      expect.arrayContaining(["k1", "k2"]),
    );
    expect(syncCompanyRuleMemberships).toHaveBeenCalled();
  });

  it("swallows a syncCompanyRuleMemberships failure (best-effort) and still succeeds", async () => {
    fake.seed("contacts", [{ id: "k1", user_id: USER, company_id: COMPANY }]);
    syncCompanyRuleMemberships.mockRejectedValueOnce(new Error("membership sync boom"));

    const res = await deleteCompany({ data: { id: COMPANY }, ...ctx });
    expect(res).toEqual({ ok: true });
    expect(fake.calls.deletes.find((d) => d.table === "companies")).toBeTruthy();
  });

  it("propagates a hard failure to delete the company row", async () => {
    fake.seed("contacts", []);
    fake.onDelete("companies", () => ({ message: "delete blocked" }));
    await expect(deleteCompany({ data: { id: COMPANY }, ...ctx })).rejects.toThrow(
      "delete blocked",
    );
  });
});
