// Behavioural tests for src/lib/companies/company-people.functions.ts.
//
// All three server fns take a client-supplied company id (and, for
// `enhanceContactWithNewEmail`, a contact id) and guard it with an explicit
// `.eq("user_id", userId)` on the request-scoped client, so cross-tenant
// denial is unit-testable via `expectDeniedCrossUser`.
//
// NOTE on the fake: `findCompanyPeopleByDomain` filters `emails` and
// `calendar_contacts` with a PostgREST `.or("from_addr.ilike.*@acme.com")`
// string. The shared fake's LIKE translation understands SQL `%`/`_` but not
// PostgREST's query-string `*` wildcard, so a seeded row could never match.
// `starWildcardClient` below translates `*` to `%` on the way into the fake
// (which is exactly what PostgREST does server-side) and remembers the
// untranslated expressions so a test can still assert what the source built.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeSupabaseFake,
  mockSupabaseAdmin,
  writeCount,
  writesTo,
  type SelectBuilder,
} from "@/lib/__fixtures__/supabase-fake";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";

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

const generateText = vi.hoisted(() => vi.fn<(args: unknown) => Promise<unknown>>());
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    generateText: (args: unknown) => generateText(args),
    Output: { object: (o: unknown) => o },
    NoObjectGeneratedError: actual.NoObjectGeneratedError,
  };
});
vi.mock("@/lib/ai-gateway", () => ({
  getModel: () => ({ modelId: "test-model" }),
}));

const convergeCompanyMemberships = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
vi.mock("./converge", () => ({
  convergeCompanyMemberships: (...args: unknown[]) => convergeCompanyMemberships(...args),
}));

import {
  findCompanyPeopleByDomain,
  addCompanyPeople,
  enhanceContactWithNewEmail,
} from "./company-people.functions";

const USER = TEST_USER;
const ATTACKER = "attacker-user-9";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";

/** Raw `.or()` expressions the code under test built, in call order. */
const orExpressions: string[] = [];

/** The fake's client with PostgREST `*` wildcards translated to SQL `%`
 *  inside `.or()` expressions, so `ilike` terms actually filter rows. */
function wrapSelectBuilder(builder: SelectBuilder): SelectBuilder {
  const proxy: SelectBuilder = new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "or") {
        return (expr: string) => {
          orExpressions.push(expr);
          target.or(expr.replace(/\*/g, "%"));
          return proxy;
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        return result === target ? proxy : result;
      };
    },
  });
  return proxy;
}

const starWildcardClient = {
  ...fake.supabaseAdmin,
  from(table: string) {
    const t = fake.supabaseAdmin.from(table);
    return {
      ...t,
      select: (columns?: string, options?: unknown) =>
        wrapSelectBuilder(t.select(columns, options)),
    };
  },
};

/** Server fns here read `context.supabase` (the request-scoped client). */
const ctx = { context: { supabase: starWildcardClient } };
const asAttacker = { context: { supabase: starWildcardClient, userId: ATTACKER } };

beforeEach(() => {
  fake.reset();
  orExpressions.length = 0;
  convergeCompanyMemberships.mockResolvedValue(undefined);
  generateText.mockReset();
  vi.stubEnv("LOVABLE_API_KEY", undefined);
});

function seedCompany(id = COMPANY, userId = USER, name = "Acme Corp") {
  fake.seed("companies", [{ id, user_id: userId, name }]);
}

/* -------------------------------------------------------------------------- */
/* findCompanyPeopleByDomain                                                   */
/* -------------------------------------------------------------------------- */

describe("findCompanyPeopleByDomain", () => {
  it("denies a cross-user company id and writes nothing", async () => {
    seedCompany(COMPANY, "victim-user");
    await expectDeniedCrossUser({
      fake,
      call: () => findCompanyPeopleByDomain({ data: { companyId: COMPANY }, ...asAttacker }),
      rejects: "Company not found",
    });
  });

  it("returns no domains and never queries mail when every domain is personal", async () => {
    seedCompany();
    fake.seed("company_domains", [
      { company_id: COMPANY, user_id: USER, domain: "gmail.com", source: "email" },
    ]);

    const res = await findCompanyPeopleByDomain({ data: { companyId: COMPANY }, ...ctx });

    expect(res).toStrictEqual({ people: [], domains: [] });
    expect(fake.calls.selects.map((s) => s.table)).toStrictEqual(["companies", "company_domains"]);
    expect(writeCount(fake)).toBe(0);
  });

  it("aggregates senders and attendees, excluding own accounts, known contacts and off-domain addresses", async () => {
    seedCompany();
    fake.seed("company_domains", [
      { company_id: COMPANY, user_id: USER, domain: "ACME.com", source: "email" },
      // Personal domains are dropped before the mail query is built.
      { company_id: COMPANY, user_id: USER, domain: "gmail.com", source: "email" },
    ]);
    fake.seed("contacts", [
      { id: "c-known", user_id: USER, name: "Known Person", email: "known@acme.com" },
    ]);
    fake.seed("contact_emails", [
      { contact_id: "c-known", user_id: USER, address: "secondary@acme.com", is_primary: false },
    ]);
    fake.seed("gmail_accounts", [{ id: "ga-1", user_id: USER, email_address: "me@acme.com" }]);

    fake.seed("emails", [
      {
        id: "e1",
        user_id: USER,
        from_addr: "Jane.Roe@acme.com",
        received_at: "2026-01-02T00:00:00Z",
      },
      {
        id: "e2",
        user_id: USER,
        from_addr: "jane.roe@acme.com",
        received_at: "2026-01-05T00:00:00Z",
      },
      // Excluded: the user's own gmail account address.
      { id: "e3", user_id: USER, from_addr: "me@acme.com", received_at: "2026-01-06T00:00:00Z" },
      // Excluded: already a contact (primary, then secondary).
      { id: "e4", user_id: USER, from_addr: "known@acme.com", received_at: "2026-01-06T00:00:00Z" },
      {
        id: "e5",
        user_id: USER,
        from_addr: "secondary@acme.com",
        received_at: "2026-01-06T00:00:00Z",
      },
      // Excluded: a subdomain is not an exact domain match.
      {
        id: "e6",
        user_id: USER,
        from_addr: "sub@mail.acme.com",
        received_at: "2026-01-06T00:00:00Z",
      },
      // Excluded: role address.
      {
        id: "e7",
        user_id: USER,
        from_addr: "noreply@acme.com",
        received_at: "2026-01-06T00:00:00Z",
      },
      // Excluded: another tenant's mail.
      {
        id: "e8",
        user_id: "victim-user",
        from_addr: "leak@acme.com",
        received_at: "2026-01-07T00:00:00Z",
      },
    ]);
    fake.seed("calendar_contacts", [
      {
        id: "cc1",
        user_id: USER,
        email_address: "jane.roe@acme.com",
        last_seen_at: "2026-02-01T00:00:00Z",
      },
      {
        id: "cc2",
        user_id: USER,
        email_address: "sam.smith@acme.com",
        last_seen_at: "2026-01-01T00:00:00Z",
      },
    ]);

    const res = await findCompanyPeopleByDomain({ data: { companyId: COMPANY }, ...ctx });

    expect(res.domains).toStrictEqual(["acme.com"]);
    expect(res.people).toStrictEqual([
      {
        email: "jane.roe@acme.com",
        name: "Jane Roe",
        sources: ["email", "calendar"],
        count: 3,
        lastSeenAt: "2026-02-01T00:00:00Z",
        possibleMatches: [],
      },
      {
        email: "sam.smith@acme.com",
        name: "Sam Smith",
        sources: ["calendar"],
        count: 1,
        lastSeenAt: "2026-01-01T00:00:00Z",
        possibleMatches: [],
      },
    ]);
    expect(writeCount(fake)).toBe(0);
  });

  it("scopes every candidate query to the caller and builds one ilike term per domain", async () => {
    seedCompany();
    fake.seed("company_domains", [
      { company_id: COMPANY, user_id: USER, domain: "acme.com", source: "email" },
      { company_id: COMPANY, user_id: USER, domain: "acme.io", source: "site" },
    ]);

    await findCompanyPeopleByDomain({ data: { companyId: COMPANY }, ...ctx });

    expect(orExpressions).toStrictEqual([
      "from_addr.ilike.*@acme.com,from_addr.ilike.*@acme.io",
      "email_address.ilike.*@acme.com,email_address.ilike.*@acme.io",
    ]);
    // Every candidate-side read is scoped to the caller.
    const scoped = ["emails", "calendar_contacts", "contacts", "contact_emails", "gmail_accounts"];
    for (const table of scoped) {
      const sel = fake.calls.selects.find((s) => s.table === table);
      expect(sel?.filters, `${table} must be scoped to the caller`).toContainEqual({
        op: "eq",
        col: "user_id",
        value: USER,
        extra: undefined,
      });
    }
  });

  it("offers the AI only the caller's own contacts and promotes its pick to the top", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "k");
    seedCompany();
    fake.seed("company_domains", [
      { company_id: COMPANY, user_id: USER, domain: "acme.com", source: "email" },
    ]);
    fake.seed("contacts", [
      { id: "c-mine-1", user_id: USER, name: "John Doe", email: "jdoe@old.test" },
      { id: "c-mine-2", user_id: USER, name: "John Doe", email: "john.doe@other.test" },
      // Another tenant's identically named contact must never reach the prompt.
      { id: "c-foreign", user_id: "victim-user", name: "John Doe", email: "jd@victim.test" },
    ]);
    fake.seed("emails", [
      {
        id: "e1",
        user_id: USER,
        from_addr: "john.doe@acme.com",
        received_at: "2026-03-01T00:00:00Z",
      },
    ]);
    generateText.mockResolvedValue({
      output: { picks: [{ email: "john.doe@acme.com", bestContactId: "c-mine-2" }] },
    });

    const res = await findCompanyPeopleByDomain({ data: { companyId: COMPANY }, ...ctx });

    expect(generateText).toHaveBeenCalledTimes(1);
    const prompt = (generateText.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain("id=c-mine-1");
    expect(prompt).toContain("id=c-mine-2");
    expect(prompt).not.toContain("c-foreign");
    expect(prompt).not.toContain("victim.test");

    const matches = res.people[0]!.possibleMatches;
    expect(matches.map((m) => m.contactId)).toStrictEqual(["c-mine-2", "c-mine-1"]);
    expect(matches[0]).toStrictEqual({
      contactId: "c-mine-2",
      contactName: "John Doe",
      contactEmail: "john.doe@other.test",
      reason: "name_exact",
      score: 0.95,
      sameCompanyId: false,
      differentDomain: true,
    });
  });

  it("keeps the heuristic ordering when the AI tie-break throws", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "k");
    seedCompany();
    fake.seed("company_domains", [
      { company_id: COMPANY, user_id: USER, domain: "acme.com", source: "email" },
    ]);
    fake.seed("contacts", [
      { id: "c-mine-1", user_id: USER, name: "John Doe", email: "jdoe@old.test" },
      { id: "c-mine-2", user_id: USER, name: "John Doe", email: "john.doe@other.test" },
    ]);
    fake.seed("emails", [
      {
        id: "e1",
        user_id: USER,
        from_addr: "john.doe@acme.com",
        received_at: "2026-03-01T00:00:00Z",
      },
    ]);
    generateText.mockRejectedValue(new Error("gateway down"));

    const res = await findCompanyPeopleByDomain({ data: { companyId: COMPANY }, ...ctx });

    expect(res.people[0]!.possibleMatches.map((m) => m.contactId)).toStrictEqual([
      "c-mine-1",
      "c-mine-2",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* addCompanyPeople                                                            */
/* -------------------------------------------------------------------------- */

describe("addCompanyPeople", () => {
  it("denies a cross-user company id and writes nothing", async () => {
    seedCompany(COMPANY, "victim-user");
    await expectDeniedCrossUser({
      fake,
      call: () =>
        addCompanyPeople({
          data: { companyId: COMPANY, items: [{ email: "new@acme.com" }] },
          ...asAttacker,
        }),
      rejects: "Company not found",
    });
  });

  it("links unlinked contacts, inserts net-new ones and leaves already-placed rows alone", async () => {
    seedCompany();
    fake.seed("contacts", [
      // Unlinked → updated onto the company, name backfilled.
      { id: "c-unlinked", user_id: USER, email: "unlinked@acme.com", company_id: null, name: null },
      // Already at another company → skipped entirely.
      {
        id: "c-placed",
        user_id: USER,
        email: "placed@acme.com",
        company_id: OTHER_COMPANY,
        name: "Placed",
      },
    ]);
    fake.onInsert("contacts", () => ({ data: [{ id: "c-new" }] }));

    const res = await addCompanyPeople({
      data: {
        companyId: COMPANY,
        items: [
          { email: "Unlinked@acme.com", name: "Unlinked Person" },
          { email: "placed@acme.com", name: "Ignored" },
          { email: "New@acme.com", name: "New Person" },
          // Duplicate of the previous item — deduped before the lookup.
          { email: "new@acme.com", name: "Second Name" },
        ],
      },
      ...ctx,
    });

    expect(res).toStrictEqual({ added: 2 });

    const updates = writesTo(fake, "updates", "contacts");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toStrictEqual({
      company: "Acme Corp",
      company_id: COMPANY,
      name: "Unlinked Person",
    });
    expect(updates[0]!.filters).toStrictEqual([
      { op: "eq", col: "id", value: "c-unlinked", extra: undefined },
      { op: "eq", col: "user_id", value: USER, extra: undefined },
    ]);

    const inserts = writesTo(fake, "inserts", "contacts");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload).toStrictEqual([
      {
        user_id: USER,
        email: "new@acme.com",
        name: "New Person",
        company: "Acme Corp",
        company_id: COMPANY,
        source: "email",
      },
    ]);

    expect(convergeCompanyMemberships).toHaveBeenCalledWith(starWildcardClient, USER, {
      companyIds: [COMPANY],
      contactIds: ["c-unlinked", "c-new"],
      bumpResync: true,
    });
  });

  it("does not converge when every supplied address is already placed", async () => {
    seedCompany();
    fake.seed("contacts", [
      { id: "c-placed", user_id: USER, email: "placed@acme.com", company_id: OTHER_COMPANY },
    ]);

    const res = await addCompanyPeople({
      data: { companyId: COMPANY, items: [{ email: "placed@acme.com" }] },
      ...ctx,
    });

    expect(res).toStrictEqual({ added: 0 });
    expect(writeCount(fake)).toBe(0);
    expect(convergeCompanyMemberships).not.toHaveBeenCalled();
  });

  it("propagates an insert failure", async () => {
    seedCompany();
    fake.onInsert("contacts", () => ({ message: "insert blocked" }));

    await expect(
      addCompanyPeople({
        data: { companyId: COMPANY, items: [{ email: "new@acme.com" }] },
        ...ctx,
      }),
    ).rejects.toThrow("insert blocked");
    expect(convergeCompanyMemberships).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* enhanceContactWithNewEmail                                                  */
/* -------------------------------------------------------------------------- */

describe("enhanceContactWithNewEmail", () => {
  it("denies a cross-user contact id and writes nothing", async () => {
    seedCompany(COMPANY, ATTACKER);
    fake.seed("contacts", [{ id: CONTACT, user_id: "victim-user", email: "victim@acme.com" }]);

    await expectDeniedCrossUser({
      fake,
      call: () =>
        enhanceContactWithNewEmail({
          data: { contactId: CONTACT, companyId: COMPANY, email: "new@acme.com" },
          ...asAttacker,
        }),
      rejects: "Contact not found",
    });
  });

  it("denies a cross-user company id and writes nothing", async () => {
    seedCompany(COMPANY, "victim-user");
    fake.seed("contacts", [{ id: CONTACT, user_id: ATTACKER, email: "mine@acme.com" }]);

    await expectDeniedCrossUser({
      fake,
      call: () =>
        enhanceContactWithNewEmail({
          data: { contactId: CONTACT, companyId: COMPANY, email: "new@acme.com" },
          ...asAttacker,
        }),
      rejects: "Company not found",
    });
  });

  it("replace_primary swaps the primary and keeps the old address as a secondary", async () => {
    seedCompany();
    fake.seed("contacts", [
      { id: CONTACT, user_id: USER, email: "old@acme.com", name: null, company_id: null },
    ]);

    const res = await enhanceContactWithNewEmail({
      data: {
        contactId: CONTACT,
        companyId: COMPANY,
        email: "New@Acme.com",
        name: "New Name",
        mode: "replace_primary",
      },
      ...ctx,
    });

    expect(res).toStrictEqual({ contactId: CONTACT });

    const updates = writesTo(fake, "updates", "contacts");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toStrictEqual({
      email: "new@acme.com",
      company: "Acme Corp",
      company_id: COMPANY,
      name: "New Name",
    });
    expect(updates[0]!.filters).toStrictEqual([
      { op: "eq", col: "id", value: CONTACT, extra: undefined },
      { op: "eq", col: "user_id", value: USER, extra: undefined },
    ]);

    const secondary = writesTo(fake, "inserts", "contact_emails");
    expect(secondary).toHaveLength(1);
    expect(secondary[0]!.payload).toStrictEqual({
      user_id: USER,
      contact_id: CONTACT,
      address: "old@acme.com",
      is_primary: false,
    });
  });

  it("add_secondary keeps the primary, attaches the address and links the company once", async () => {
    seedCompany();
    fake.seed("contacts", [
      { id: CONTACT, user_id: USER, email: "old@acme.com", name: "Existing", company_id: null },
    ]);

    await enhanceContactWithNewEmail({
      data: { contactId: CONTACT, companyId: COMPANY, email: "new@acme.com" },
      ...ctx,
    });

    const updates = writesTo(fake, "updates", "contacts");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toStrictEqual({ company: "Acme Corp", company_id: COMPANY });

    const inserts = writesTo(fake, "inserts", "contact_emails");
    expect(inserts[0]!.payload).toStrictEqual({
      user_id: USER,
      contact_id: CONTACT,
      address: "new@acme.com",
      is_primary: false,
    });
    expect(convergeCompanyMemberships).toHaveBeenCalledWith(starWildcardClient, USER, {
      companyIds: [COMPANY],
      contactIds: [CONTACT],
      bumpResync: true,
    });
  });

  it("swallows a duplicate-key collision on the secondary address", async () => {
    seedCompany();
    fake.seed("contacts", [
      { id: CONTACT, user_id: USER, email: "old@acme.com", company_id: COMPANY },
    ]);
    fake.onInsert("contact_emails", () => ({ message: "duplicate key value violates unique" }));

    await expect(
      enhanceContactWithNewEmail({
        data: { contactId: CONTACT, companyId: COMPANY, email: "new@acme.com" },
        ...ctx,
      }),
    ).resolves.toStrictEqual({ contactId: CONTACT });
  });

  it("rejects an address already used by a different contact of the same user", async () => {
    seedCompany();
    fake.seed("contacts", [
      { id: CONTACT, user_id: USER, email: "old@acme.com" },
      { id: "c-other", user_id: USER, email: "new@acme.com" },
    ]);

    await expect(
      enhanceContactWithNewEmail({
        data: { contactId: CONTACT, companyId: COMPANY, email: "new@acme.com" },
        ...ctx,
      }),
    ).rejects.toThrow("Another contact already uses that email");
    expect(writeCount(fake)).toBe(0);
  });
});
