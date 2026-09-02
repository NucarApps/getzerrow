// Read/CRUD half of src/lib/companies/companies.functions.ts: the pure
// brand-clustering core (`tokenize` + `clusterCompanies`) plus every
// non-destructive server fn. The merge pipeline, `deleteCompany` and
// `findDuplicateCompanies` live in companies.functions.merge.test.ts.
//
// Every fn here takes a client-supplied id and runs on the request-scoped
// client (`context.supabase`). Reads carry an explicit `.eq("user_id", …)`,
// so a foreign id is a real rejection; writes carry the same filter, so a
// foreign id is a silent no-op rather than a throw — those are asserted
// against the post-write rows instead of with `expectDeniedCrossUser`.

import { describe, it, expect, beforeEach, vi } from "vitest";
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
const findOrCreateCompanyByName = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ id: string; name: string } | null>>(),
);
vi.mock("./resolve.server", () => ({
  findOrCreateCompanyByName: (...args: unknown[]) => findOrCreateCompanyByName(...args),
  resolveContactCompany: vi.fn(),
}));

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
  tokenize,
  clusterCompanies,
  listCompanies,
  getCompany,
  createCompany,
  discoverCompanyDomains,
  openOrCreateCompanyForBucket,
  convergeBucketCompany,
  updateCompany,
  addCompanyDomain,
  removeCompanyDomain,
  setCompanyTags,
  previewMergeCompanies,
  type CompanyLite,
} from "./companies.functions";

const USER = TEST_USER;
const ATTACKER = "attacker-user-9";
const VICTIM = "victim-user-7";
const COMPANY = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_COMPANY = "bbbbbbbb-2222-4222-8222-222222222222";
const GROUP = "cccccccc-3333-4333-8333-333333333333";
const CONTACT = "dddddddd-4444-4444-8444-444444444444";
const MY_DOMAIN = "eeeeeeee-5555-4555-8555-555555555555";
const FOREIGN_DOMAIN = "ffffffff-6666-4666-8666-666666666666";

const ctx = { context: { supabase: fake.supabaseAdmin } };
const asAttacker = { context: { supabase: fake.supabaseAdmin, userId: ATTACKER } };

/** Call a stubbed server fn that takes no `data` with a request context. The
 *  real `createServerFn` signature has no `context` slot (middleware supplies
 *  it), so only the stub honors one — same trick as `impersonate`, which sets
 *  `userId` alone. */
function withContext<R>(
  fn: (...args: never[]) => Promise<R>,
  context: Record<string, unknown>,
): () => Promise<R> {
  const stubbed = fn as unknown as (a: { context: Record<string, unknown> }) => Promise<R>;
  return () => stubbed({ context });
}
const listCompaniesAsUser = withContext(listCompanies, ctx.context);

function co(id: string, name: string, domains: string[] = [], member_count = 0): CompanyLite {
  return { id, name, member_count, domains };
}

beforeEach(() => {
  fake.reset();
  findOrCreateCompanyByName.mockReset();
  reconcileAutoParentsForContacts.mockResolvedValue(undefined);
  syncCompanyRuleMemberships.mockResolvedValue(undefined);
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
    const ids = clusters[0]!.map((c) => c.id).sort();
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
    expect(clusters[0]!.map((c) => c.id).sort()).toEqual(["n1", "n2"]);
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
/* listCompanies / getCompany                                                  */
/* -------------------------------------------------------------------------- */

describe("listCompanies", () => {
  it("returns only the caller's companies with their domains and member counts", async () => {
    fake.seed("companies", [
      { id: COMPANY, user_id: USER, name: "Acme", website: null, industry: null, logo_url: null },
      { id: OTHER_COMPANY, user_id: VICTIM, name: "Victim Co" },
    ]);
    fake.seed("company_domains", [
      {
        id: "d1",
        user_id: USER,
        company_id: COMPANY,
        domain: "acme.test",
        source: "manual",
        member_count: 3,
        discovered_from_contact_id: null,
      },
    ]);
    fake.seed("contacts", [
      { id: "k1", user_id: USER, company_id: COMPANY },
      { id: "k2", user_id: USER, company_id: COMPANY },
    ]);

    const res = await listCompaniesAsUser();

    expect(res).toStrictEqual({
      companies: [
        {
          id: COMPANY,
          user_id: USER,
          name: "Acme",
          website: null,
          industry: null,
          logo_url: null,
          domains: [
            {
              domain: "acme.test",
              source: "manual",
              member_count: 3,
              discovered_from_contact_id: null,
            },
          ],
          member_count: 2,
        },
      ],
    });
  });

  it("short-circuits the satellite queries when the caller has no companies", async () => {
    const res = await listCompaniesAsUser();
    expect(res).toStrictEqual({ companies: [] });
    expect(fake.calls.selects.map((s) => s.table)).toStrictEqual(["companies"]);
  });

  it("propagates a read failure", async () => {
    fake.onSelect("companies", () => ({ message: "select blocked" }));
    await expect(listCompaniesAsUser()).rejects.toThrow("select blocked");
  });
});

describe("getCompany", () => {
  it("denies a cross-user company id and writes nothing", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: VICTIM, name: "Victim Co" }]);
    await expectDeniedCrossUser({
      fake,
      call: () => getCompany({ data: { id: COMPANY }, ...asAttacker }),
      rejects: "Company not found",
    });
  });

  it("resolves the introducing contact behind each auto-discovered domain", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme" }]);
    fake.seed("company_domains", [
      {
        id: "d1",
        user_id: USER,
        company_id: COMPANY,
        domain: "acme.test",
        source: "auto",
        member_count: 1,
        discovered_from_contact_id: CONTACT,
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);
    fake.seed("company_tags", [{ id: "t1", user_id: USER, company_id: COMPANY, tag: "vip" }]);
    fake.seed("contacts", [
      {
        id: CONTACT,
        user_id: USER,
        company_id: COMPANY,
        name: "Intro Person",
        email: "intro@acme.test",
        title: null,
        avatar_url: null,
      },
    ]);

    const res = await getCompany({ data: { id: COMPANY }, ...ctx });

    expect(res.company).toStrictEqual({ id: COMPANY, user_id: USER, name: "Acme" });
    expect(res.domains).toStrictEqual([
      {
        id: "d1",
        user_id: USER,
        company_id: COMPANY,
        domain: "acme.test",
        source: "auto",
        member_count: 1,
        discovered_from_contact_id: CONTACT,
        created_at: "2026-01-01T00:00:00Z",
        discovered_from: { name: "Intro Person", email: "intro@acme.test" },
      },
    ]);
    expect(res.tags).toStrictEqual([{ id: "t1", user_id: USER, company_id: COMPANY, tag: "vip" }]);
    expect(res.members).toStrictEqual([
      {
        id: CONTACT,
        user_id: USER,
        company_id: COMPANY,
        name: "Intro Person",
        email: "intro@acme.test",
        title: null,
        avatar_url: null,
      },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* createCompany / discoverCompanyDomains                                      */
/* -------------------------------------------------------------------------- */

describe("createCompany", () => {
  it("resolves the name through the shared resolver and returns the row", async () => {
    findOrCreateCompanyByName.mockResolvedValue({ id: COMPANY, name: "Acme" });

    const res = await createCompany({ data: { name: "  Acme  " }, ...ctx });

    expect(res).toStrictEqual({ id: COMPANY, name: "Acme" });
    expect(findOrCreateCompanyByName).toHaveBeenCalledWith(
      { supabase: fake.supabaseAdmin, userId: USER },
      "Acme",
    );
  });

  it("rejects a name that normalizes to nothing", async () => {
    findOrCreateCompanyByName.mockResolvedValue(null);
    await expect(createCompany({ data: { name: "..." }, ...ctx })).rejects.toThrow(
      "Invalid company name",
    );
  });
});

describe("discoverCompanyDomains", () => {
  // RLS-RELIANCE: the client-supplied company id is only checked inside the
  // SECURITY DEFINER `discover_company_domains`, which is handed the caller's
  // own user id. A foreign id therefore returns zero counts; this asserts the
  // call carries that user id and records no client-side write.
  it("passes the caller's own user id to the RPC and returns its counters", async () => {
    fake.onRpc("discover_company_domains", () => ({
      data: [{ added: 2, updated: 1, total_auto: 5 }],
    }));

    const res = await discoverCompanyDomains({ data: { id: COMPANY }, ...asAttacker });

    expect(res).toStrictEqual({ added: 2, updated: 1, total: 5 });
    expect(fake.calls.rpcs).toStrictEqual([
      { fn: "discover_company_domains", args: { p_company_id: COMPANY, p_user_id: ATTACKER } },
    ]);
    expect(writeCount(fake)).toBe(0);
  });

  it("defaults every counter to zero when the RPC returns no rows", async () => {
    const res = await discoverCompanyDomains({ data: { id: COMPANY }, ...ctx });
    expect(res).toStrictEqual({ added: 0, updated: 0, total: 0 });
  });

  it("propagates an RPC failure", async () => {
    fake.onRpc("discover_company_domains", () => ({ error: { message: "rpc blocked" } }));
    await expect(discoverCompanyDomains({ data: { id: COMPANY }, ...ctx })).rejects.toThrow(
      "rpc blocked",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* openOrCreateCompanyForBucket / convergeBucketCompany                        */
/* -------------------------------------------------------------------------- */

describe("openOrCreateCompanyForBucket", () => {
  it("prefers an existing owner of the domain over minting a company", async () => {
    fake.seed("company_domains", [
      { id: "d1", user_id: USER, company_id: COMPANY, domain: "acme.test", source: "manual" },
    ]);
    fake.seed("contacts", [{ id: CONTACT, user_id: USER, company_id: null }]);

    const res = await openOrCreateCompanyForBucket({
      data: { name: "Acme", domain: "ACME.test", contactIds: [CONTACT] },
      ...ctx,
    });

    expect(res).toStrictEqual({ companyId: COMPANY });
    expect(findOrCreateCompanyByName).not.toHaveBeenCalled();
    expect(writesTo(fake, "upserts", "company_domains")[0]!.payload).toStrictEqual({
      user_id: USER,
      company_id: COMPANY,
      domain: "acme.test",
      source: "manual",
    });
    expect(fake.rows("contacts")).toStrictEqual([
      { id: CONTACT, user_id: USER, company_id: COMPANY },
    ]);
  });

  it("ignores a personal domain and resolves the bucket by its free-text name", async () => {
    findOrCreateCompanyByName.mockResolvedValue({ id: COMPANY, name: "Acme" });
    fake.seed("contacts", [{ id: CONTACT, user_id: USER, company_id: null }]);

    const res = await openOrCreateCompanyForBucket({
      data: { name: "Acme", domain: "gmail.com", contactIds: [CONTACT] },
      ...ctx,
    });

    expect(res).toStrictEqual({ companyId: COMPANY });
    expect(findOrCreateCompanyByName).toHaveBeenCalledWith(
      { supabase: fake.supabaseAdmin, userId: USER },
      "Acme",
    );
    // No domain to attach — only the contact link is written.
    expect(writesTo(fake, "upserts", "company_domains")).toHaveLength(0);
  });

  it("mints a company named from the domain when the bucket has no name", async () => {
    findOrCreateCompanyByName.mockResolvedValue({ id: COMPANY, name: "Acme" });
    fake.seed("contacts", [{ id: CONTACT, user_id: USER, company_id: null }]);

    await openOrCreateCompanyForBucket({
      data: { domain: "acme.test", contactIds: [CONTACT] },
      ...ctx,
    });

    expect(findOrCreateCompanyByName).toHaveBeenCalledWith(
      { supabase: fake.supabaseAdmin, userId: USER },
      "Acme",
    );
  });

  it("throws when neither a name nor a usable domain resolves a company", async () => {
    await expect(
      openOrCreateCompanyForBucket({ data: { contactIds: [CONTACT] }, ...ctx }),
    ).rejects.toThrow("Could not resolve a company for this group");
    expect(writeCount(fake)).toBe(0);
  });

  it("cannot relink another user's contacts", async () => {
    findOrCreateCompanyByName.mockResolvedValue({ id: COMPANY, name: "Acme" });
    fake.seed("contacts", [{ id: CONTACT, user_id: VICTIM, company_id: OTHER_COMPANY }]);

    await openOrCreateCompanyForBucket({
      data: { name: "Acme", contactIds: [CONTACT] },
      ...asAttacker,
    });

    expect(fake.rows("contacts")).toStrictEqual([
      { id: CONTACT, user_id: VICTIM, company_id: OTHER_COMPANY },
    ]);
  });
});

describe("convergeBucketCompany", () => {
  it("re-derives domains and converges memberships for the caller", async () => {
    const res = await convergeBucketCompany({
      data: { companyId: COMPANY, contactIds: [CONTACT] },
      ...ctx,
    });

    expect(res).toStrictEqual({ ok: true });
    expect(fake.calls.rpcs).toStrictEqual([
      { fn: "discover_company_domains", args: { p_company_id: COMPANY, p_user_id: USER } },
    ]);
    expect(syncCompanyRuleMemberships).toHaveBeenCalledWith(fake.supabaseAdmin, USER, {
      companyIds: [COMPANY],
      contactIds: [CONTACT],
      bumpResync: true,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* updateCompany                                                               */
/* -------------------------------------------------------------------------- */

describe("updateCompany", () => {
  it("rejects a linked_group_id belonging to another user before any write", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme" }]);
    fake.seed("contact_groups", [{ id: GROUP, user_id: VICTIM, name: "Victim Group" }]);

    await expectDeniedCrossUser({
      fake,
      call: () => updateCompany({ data: { id: COMPANY, linked_group_id: GROUP }, ...ctx }),
      rejects: "Group not found",
    });
  });

  it("recomputes name_key, renames linked contacts and reconciles their subgroups", async () => {
    fake.seed("companies", [
      { id: COMPANY, user_id: USER, name: "Acme", name_key: "acme", industry: null },
    ]);
    fake.seed("contacts", [
      { id: CONTACT, user_id: USER, company_id: COMPANY, company: "Acme" },
      { id: "other", user_id: USER, company_id: OTHER_COMPANY, company: "Other" },
    ]);

    const res = await updateCompany({
      data: { id: COMPANY, name: "Acme Corporation", industry: "Auto" },
      ...ctx,
    });

    expect(res).toStrictEqual({ ok: true });
    const update = writesTo(fake, "updates", "companies")[0]!;
    expect(update.payload).toStrictEqual({
      name: "Acme Corporation",
      industry: "Auto",
      name_key: "acme",
    });
    expect(update.filters).toStrictEqual([
      { op: "eq", col: "id", value: COMPANY, extra: undefined },
      { op: "eq", col: "user_id", value: USER, extra: undefined },
    ]);
    expect(fake.rows("contacts")).toStrictEqual([
      { id: CONTACT, user_id: USER, company_id: COMPANY, company: "Acme Corporation" },
      { id: "other", user_id: USER, company_id: OTHER_COMPANY, company: "Other" },
    ]);
    expect(reconcileAutoParentsForContacts).toHaveBeenCalledWith(fake.supabaseAdmin, USER, [
      CONTACT,
    ]);
  });

  it("leaves contacts alone when the name is not part of the patch", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme" }]);
    fake.seed("contacts", [{ id: CONTACT, user_id: USER, company_id: COMPANY, company: "Acme" }]);

    await updateCompany({ data: { id: COMPANY, website: "https://acme.test" }, ...ctx });

    expect(writesTo(fake, "updates", "contacts")).toHaveLength(0);
    expect(reconcileAutoParentsForContacts).not.toHaveBeenCalled();
  });

  it("translates a unique-name violation into a readable message", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme" }]);
    fake.onUpdate("companies", () => ({ message: "duplicate key", code: "23505" }));

    await expect(updateCompany({ data: { id: COMPANY, name: "Taken" }, ...ctx })).rejects.toThrow(
      "Another company already uses that name.",
    );
  });

  it("cannot rename another user's company", async () => {
    fake.seed("companies", [
      { id: COMPANY, user_id: VICTIM, name: "Victim Co", name_key: "victim co" },
    ]);

    await updateCompany({ data: { id: COMPANY, name: "Stolen" }, ...asAttacker });

    expect(fake.rows("companies")).toStrictEqual([
      { id: COMPANY, user_id: VICTIM, name: "Victim Co", name_key: "victim co" },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* addCompanyDomain / removeCompanyDomain                                      */
/* -------------------------------------------------------------------------- */

describe("addCompanyDomain", () => {
  it("denies a cross-user company id and writes nothing", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: VICTIM, name: "Victim Co" }]);
    await expectDeniedCrossUser({
      fake,
      call: () => addCompanyDomain({ data: { id: COMPANY, domain: "acme.test" }, ...asAttacker }),
      rejects: "Company not found",
    });
  });

  it("rejects a value that is not a routable domain before any ownership read", async () => {
    await expect(
      addCompanyDomain({ data: { id: COMPANY, domain: "localhost" }, ...ctx }),
    ).rejects.toThrow("Invalid domain");
    expect(fake.calls.selects).toHaveLength(0);
    expect(writeCount(fake)).toBe(0);
  });

  it("strips an address down to its domain and attaches it as manual", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme" }]);

    const res = await addCompanyDomain({
      data: { id: COMPANY, domain: "Someone@ACME.test" },
      ...ctx,
    });

    expect(res).toStrictEqual({ ok: true, domain: "acme.test" });
    expect(writesTo(fake, "inserts", "company_domains")[0]!.payload).toStrictEqual({
      user_id: USER,
      company_id: COMPANY,
      domain: "acme.test",
      source: "manual",
    });
  });

  it("reports a conflict with the company that already owns the domain", async () => {
    fake.seed("companies", [
      { id: COMPANY, user_id: USER, name: "Acme" },
      { id: OTHER_COMPANY, user_id: USER, name: "Acme Holdings" },
    ]);
    fake.seed("company_domains", [
      { id: "d1", user_id: USER, company_id: OTHER_COMPANY, domain: "acme.test", source: "manual" },
    ]);

    const res = await addCompanyDomain({ data: { id: COMPANY, domain: "acme.test" }, ...ctx });

    expect(res).toStrictEqual({
      ok: false,
      conflict: { companyId: OTHER_COMPANY, companyName: "Acme Holdings", domain: "acme.test" },
    });
    expect(writeCount(fake)).toBe(0);
  });

  it("is idempotent when the domain is already attached to this company", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme" }]);
    fake.seed("company_domains", [
      { id: "d1", user_id: USER, company_id: COMPANY, domain: "acme.test", source: "manual" },
    ]);

    const res = await addCompanyDomain({ data: { id: COMPANY, domain: "acme.test" }, ...ctx });

    expect(res).toStrictEqual({ ok: true, domain: "acme.test", alreadyAttached: true });
    expect(writeCount(fake)).toBe(0);
  });

  it("propagates an insert failure", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme" }]);
    fake.onInsert("company_domains", () => ({ message: "insert blocked" }));
    await expect(
      addCompanyDomain({ data: { id: COMPANY, domain: "acme.test" }, ...ctx }),
    ).rejects.toThrow("insert blocked");
  });
});

describe("removeCompanyDomain", () => {
  it("deletes only the caller's own domain row", async () => {
    fake.seed("company_domains", [
      { id: MY_DOMAIN, user_id: USER, company_id: COMPANY, domain: "acme.test", source: "manual" },
      {
        id: FOREIGN_DOMAIN,
        user_id: VICTIM,
        company_id: OTHER_COMPANY,
        domain: "v.test",
        source: "manual",
      },
    ]);

    await expect(
      removeCompanyDomain({ data: { id: FOREIGN_DOMAIN }, ...ctx }),
    ).resolves.toStrictEqual({ ok: true });
    expect(fake.rows("company_domains").map((d) => d.id)).toStrictEqual([
      MY_DOMAIN,
      FOREIGN_DOMAIN,
    ]);

    await removeCompanyDomain({ data: { id: MY_DOMAIN }, ...ctx });
    expect(fake.rows("company_domains").map((d) => d.id)).toStrictEqual([FOREIGN_DOMAIN]);
  });

  it("propagates a delete failure", async () => {
    fake.onDelete("company_domains", () => ({ message: "delete blocked" }));
    await expect(removeCompanyDomain({ data: { id: MY_DOMAIN }, ...ctx })).rejects.toThrow(
      "delete blocked",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* setCompanyTags                                                              */
/* -------------------------------------------------------------------------- */

describe("setCompanyTags", () => {
  it("lowercases and dedupes the tag set, replacing the company's rows wholesale", async () => {
    fake.seed("company_tags", [
      { id: "t-old", user_id: USER, company_id: COMPANY, tag: "stale" },
      { id: "t-other", user_id: USER, company_id: OTHER_COMPANY, tag: "keep" },
    ]);

    const res = await setCompanyTags({
      data: { id: COMPANY, tags: ["VIP", "vip", " Partner "] },
      ...ctx,
    });

    expect(res).toStrictEqual({ ok: true });
    expect(writesTo(fake, "inserts", "company_tags")[0]!.payload).toStrictEqual([
      { user_id: USER, company_id: COMPANY, tag: "vip" },
      { user_id: USER, company_id: COMPANY, tag: "partner" },
    ]);
    expect(fake.rows("company_tags")).toStrictEqual([
      { id: "t-other", user_id: USER, company_id: OTHER_COMPANY, tag: "keep" },
      { user_id: USER, company_id: COMPANY, tag: "vip" },
      { user_id: USER, company_id: COMPANY, tag: "partner" },
    ]);
  });

  it("clears the tags without inserting when given an empty list", async () => {
    fake.seed("company_tags", [{ id: "t-old", user_id: USER, company_id: COMPANY, tag: "stale" }]);

    await setCompanyTags({ data: { id: COMPANY, tags: [] }, ...ctx });

    expect(fake.rows("company_tags")).toStrictEqual([]);
    expect(writesTo(fake, "inserts", "company_tags")).toHaveLength(0);
  });

  it("cannot clear another user's tags", async () => {
    fake.seed("company_tags", [{ id: "t1", user_id: VICTIM, company_id: COMPANY, tag: "vip" }]);

    await setCompanyTags({ data: { id: COMPANY, tags: [] }, ...asAttacker });

    expect(fake.rows("company_tags")).toHaveLength(1);
  });

  it("propagates a delete failure before inserting anything", async () => {
    fake.onDelete("company_tags", () => ({ message: "delete blocked" }));
    await expect(setCompanyTags({ data: { id: COMPANY, tags: ["vip"] }, ...ctx })).rejects.toThrow(
      "delete blocked",
    );
    expect(writesTo(fake, "inserts", "company_tags")).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* previewMergeCompanies                                                       */
/* -------------------------------------------------------------------------- */

describe("previewMergeCompanies", () => {
  it("denies a cross-user source company and writes nothing", async () => {
    fake.seed("companies", [
      { id: COMPANY, user_id: VICTIM, name: "Victim Co" },
      { id: OTHER_COMPANY, user_id: ATTACKER, name: "Attacker Co" },
    ]);
    await expectDeniedCrossUser({
      fake,
      call: () =>
        previewMergeCompanies({
          data: { sourceId: COMPANY, targetId: OTHER_COMPANY },
          ...asAttacker,
        }),
      rejects: "Source company not found",
    });
  });

  it("flags the domains and tags the target already has as conflicts", async () => {
    fake.seed("companies", [
      { id: COMPANY, user_id: USER, name: "Source Co" },
      { id: OTHER_COMPANY, user_id: USER, name: "Target Co" },
    ]);
    fake.seed("contacts", [
      { id: CONTACT, user_id: USER, company_id: COMPANY, name: "Moved", email: "m@src.test" },
    ]);
    fake.seed("company_domains", [
      { id: "d1", user_id: USER, company_id: COMPANY, domain: "shared.test", source: "manual" },
      { id: "d2", user_id: USER, company_id: COMPANY, domain: "only-src.test", source: "auto" },
      { id: "d3", user_id: USER, company_id: OTHER_COMPANY, domain: "shared.test", source: "auto" },
    ]);
    fake.seed("company_tags", [
      { id: "t1", user_id: USER, company_id: COMPANY, tag: "vip" },
      { id: "t2", user_id: USER, company_id: OTHER_COMPANY, tag: "vip" },
    ]);

    const res = await previewMergeCompanies({
      data: { sourceId: COMPANY, targetId: OTHER_COMPANY },
      ...ctx,
    });

    expect(res.source).toStrictEqual({ id: COMPANY, user_id: USER, name: "Source Co" });
    expect(res.target).toStrictEqual({ id: OTHER_COMPANY, user_id: USER, name: "Target Co" });
    expect(res.contactCount).toBe(1);
    expect(res.contacts).toStrictEqual([
      { id: CONTACT, user_id: USER, company_id: COMPANY, name: "Moved", email: "m@src.test" },
    ]);
    expect(res.domains).toStrictEqual([
      { domain: "shared.test", source: "manual", conflict: true },
      { domain: "only-src.test", source: "auto", conflict: false },
    ]);
    expect(res.tags).toStrictEqual([{ tag: "vip", conflict: true }]);
    expect(writeCount(fake)).toBe(0);
  });
});
