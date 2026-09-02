// loadAccountContext — the routing snapshot every classification reads.
//
// It is built once per worker batch and cached for 5 s, so a mistake here
// is a mistake applied to every message in the batch. The contracts that
// matter, and the reason each is here:
//
//   * the 5 s TTL and both invalidation hooks — a folder edit that stays
//     invisible files mail by the old rules, and a cache that never hits
//     multiplies the query cost by the batch size,
//   * cross-tenant scoping — this runs on the ADMIN client, so RLS is not
//     a backstop: overrides are scoped by user AND by the account's own
//     `.or(gmail_account_id.eq.X, is.null)`, and filters/mark-read rules
//     by `.in("folder_id", <this account's folders>)`. A missing scope
//     silently routes one tenant's mail by another tenant's rules,
//   * the calendar guard is opt-in per account and costs a query only
//     when it is on,
//   * every address key is lowercased, because the classifier looks these
//     up with a lowercased from_addr.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

import {
  invalidateAccountContext,
  invalidateAccountContextForUser,
  loadAccountContext,
} from "./account-context";

const ACC = "acc-1";
const USER = "user-1";
const OTHER_ACC = "acc-2";
const OTHER_USER = "user-2";

const selectsTo = (table: string) => fake.calls.selects.filter((s) => s.table === table);

/** A minimal but complete account: one folder, one rule, nothing else. */
function seedAccount() {
  fake.seed("gmail_accounts", [
    { id: ACC, user_id: USER, email_address: "Me@Example.com", calendar_guard_enabled: false },
  ]);
  fake.seed("folders", [
    { id: "f-1", name: "Receipts", gmail_account_id: ACC, priority: 0, ai_rule: "receipts" },
  ]);
  fake.seed("folder_filters", [
    { id: "flt-1", folder_id: "f-1", field: "domain", op: "contains", value: "stripe.com" },
  ]);
}

beforeEach(() => {
  fake.reset();
  // The cache is module-level and outlives a single test.
  invalidateAccountContext(ACC);
  invalidateAccountContext(OTHER_ACC);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the 5s cache", () => {
  it("serves a second call for the same account from memory, issuing no further reads", async () => {
    seedAccount();
    const first = await loadAccountContext(ACC, USER);
    const readsAfterFirst = fake.calls.selects.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    vi.advanceTimersByTime(4_999);
    const second = await loadAccountContext(ACC, USER);
    expect(fake.calls.selects.length).toBe(readsAfterFirst);
    // The very same object, not a re-derived equal one.
    expect(second).toBe(first);
  });

  it("re-reads once the entry has expired", async () => {
    seedAccount();
    await loadAccountContext(ACC, USER);
    const readsAfterFirst = fake.calls.selects.length;

    vi.advanceTimersByTime(5_001);
    await loadAccountContext(ACC, USER);
    expect(fake.calls.selects.length).toBeGreaterThan(readsAfterFirst);
  });

  it("caches per account, so a second account does not read the first one's snapshot", async () => {
    seedAccount();
    fake.seed("gmail_accounts", [
      { id: ACC, user_id: USER, email_address: "me@example.com", calendar_guard_enabled: false },
      {
        id: OTHER_ACC,
        user_id: OTHER_USER,
        email_address: "them@example.com",
        calendar_guard_enabled: false,
      },
    ]);
    fake.seed("folders", [
      { id: "f-1", name: "Receipts", gmail_account_id: ACC, priority: 0 },
      { id: "f-2", name: "Theirs", gmail_account_id: OTHER_ACC, priority: 0 },
    ]);

    const mine = await loadAccountContext(ACC, USER);
    const theirs = await loadAccountContext(OTHER_ACC, OTHER_USER);
    expect(mine.folders.map((f) => f.id)).toEqual(["f-1"]);
    expect(theirs.folders.map((f) => f.id)).toEqual(["f-2"]);
  });

  it("invalidateAccountContext forces the next call to re-read", async () => {
    seedAccount();
    await loadAccountContext(ACC, USER);
    const readsAfterFirst = fake.calls.selects.length;

    invalidateAccountContext(ACC);
    await loadAccountContext(ACC, USER);
    expect(fake.calls.selects.length).toBeGreaterThan(readsAfterFirst);
  });

  it("invalidateAccountContextForUser busts every account that user owns", async () => {
    fake.seed("gmail_accounts", [
      { id: ACC, user_id: USER, email_address: "me@example.com", calendar_guard_enabled: false },
      { id: OTHER_ACC, user_id: USER, email_address: "me2@example.com" },
    ]);
    fake.seed("folders", [
      { id: "f-1", name: "Receipts", gmail_account_id: ACC, priority: 0 },
      { id: "f-2", name: "Other", gmail_account_id: OTHER_ACC, priority: 0 },
    ]);
    await loadAccountContext(ACC, USER);
    await loadAccountContext(OTHER_ACC, USER);
    const readsAfterFirst = fake.calls.selects.length;

    // Cached: no new reads.
    await loadAccountContext(ACC, USER);
    await loadAccountContext(OTHER_ACC, USER);
    expect(fake.calls.selects.length).toBe(readsAfterFirst);

    await invalidateAccountContextForUser(USER);
    // Looked the accounts up by owner, not by id.
    const lookup = selectsTo("gmail_accounts").at(-1);
    expect(lookup?.filters).toContainEqual({ op: "eq", col: "user_id", value: USER });

    const afterLookup = fake.calls.selects.length;
    await loadAccountContext(ACC, USER);
    await loadAccountContext(OTHER_ACC, USER);
    expect(fake.calls.selects.length).toBeGreaterThan(afterLookup);
  });

  it("invalidateAccountContextForUser leaves another user's cache alone", async () => {
    fake.seed("gmail_accounts", [
      { id: ACC, user_id: USER, email_address: "me@example.com" },
      { id: OTHER_ACC, user_id: OTHER_USER, email_address: "them@example.com" },
    ]);
    await loadAccountContext(OTHER_ACC, OTHER_USER);
    await invalidateAccountContextForUser(USER);
    const before = fake.calls.selects.length;
    await loadAccountContext(OTHER_ACC, OTHER_USER);
    expect(fake.calls.selects.length).toBe(before);
  });
});

describe("cross-tenant scoping (the admin client has no RLS behind it)", () => {
  it("takes overrides for this account and unscoped legacy rows, but not another account's", async () => {
    seedAccount();
    fake.seed("inbox_overrides", [
      {
        id: "ov-mine",
        user_id: USER,
        gmail_account_id: ACC,
        match_type: "email",
        value: "a@x.test",
      },
      {
        id: "ov-legacy",
        user_id: USER,
        gmail_account_id: null,
        match_type: "domain",
        value: "x.test",
      },
      {
        id: "ov-other-account",
        user_id: USER,
        gmail_account_id: OTHER_ACC,
        match_type: "email",
        value: "b@x.test",
      },
      {
        id: "ov-other-user",
        user_id: OTHER_USER,
        gmail_account_id: null,
        match_type: "email",
        value: "c@x.test",
      },
    ]);

    const ctx = await loadAccountContext(ACC, USER);
    expect(ctx.overrides.map((o) => o.id).sort()).toEqual(["ov-legacy", "ov-mine"]);
  });

  it("scopes folder_filters and mark-read rules to this account's folder ids", async () => {
    seedAccount();
    fake.seed("folders", [
      { id: "f-1", name: "Receipts", gmail_account_id: ACC, priority: 0 },
      { id: "f-foreign", name: "Theirs", gmail_account_id: OTHER_ACC, priority: 0 },
    ]);
    fake.seed("folder_filters", [
      { id: "flt-1", folder_id: "f-1", field: "domain", op: "contains", value: "stripe.com" },
      { id: "flt-foreign", folder_id: "f-foreign", field: "domain", op: "contains", value: "evil" },
    ]);
    fake.seed("folder_mark_read_rules", [
      { folder_id: "f-1", match_type: "domain", value: "stripe.com" },
      { folder_id: "f-foreign", match_type: "domain", value: "evil" },
    ]);

    const ctx = await loadAccountContext(ACC, USER);
    expect(ctx.filters.map((f) => f.id)).toEqual(["flt-1"]);
    expect(ctx.markReadRules?.map((r) => r.value)).toEqual(["stripe.com"]);
    // The scope is expressed as an `in` on the account's own folder ids —
    // not a post-filter, which would still have pulled every tenant's rows.
    expect(selectsTo("folder_filters")[0]!.filters).toEqual([
      { op: "in", col: "folder_id", value: ["f-1"] },
    ]);
  });

  it("skips the filter and mark-read reads entirely when the account has no folders", async () => {
    fake.seed("gmail_accounts", [{ id: ACC, user_id: USER, email_address: "me@example.com" }]);
    const ctx = await loadAccountContext(ACC, USER);
    expect(ctx.folders).toEqual([]);
    expect(ctx.filters).toEqual([]);
    expect(ctx.enrichedFolders).toEqual([]);
    expect(selectsTo("folder_filters")).toEqual([]);
    expect(selectsTo("folder_mark_read_rules")).toEqual([]);
    expect(selectsTo("folder_examples")).toEqual([]);
  });

  it("takes only this user's override exceptions", async () => {
    seedAccount();
    fake.seed("inbox_override_exceptions", [
      { user_id: USER, override_id: "ov-1", field: "subject", op: "contains", value: "mine" },
      {
        user_id: OTHER_USER,
        override_id: "ov-9",
        field: "subject",
        op: "contains",
        value: "theirs",
      },
    ]);
    const ctx = await loadAccountContext(ACC, USER);
    expect(ctx.overrideExceptions.map((e) => e.value)).toEqual(["mine"]);
  });
});

describe("the calendar cold-email guard", () => {
  it("is off by default and costs no query", async () => {
    seedAccount();
    const ctx = await loadAccountContext(ACC, USER);
    expect(ctx.calendarGuardEnabled).toBe(false);
    expect(ctx.calendarContacts).toEqual(new Set());
    expect(selectsTo("calendar_contacts")).toEqual([]);
  });

  it("loads the account's contacts lowercased when it is on", async () => {
    seedAccount();
    fake.seed("gmail_accounts", [
      { id: ACC, user_id: USER, email_address: "me@example.com", calendar_guard_enabled: true },
    ]);
    fake.seed("calendar_contacts", [
      { gmail_account_id: ACC, email_address: "Met@Partner.COM" },
      { gmail_account_id: ACC, email_address: null },
      { gmail_account_id: OTHER_ACC, email_address: "someone@else.test" },
    ]);

    const ctx = await loadAccountContext(ACC, USER);
    expect(ctx.calendarGuardEnabled).toBe(true);
    // Lowercased, nulls dropped, and scoped to this account.
    expect(ctx.calendarContacts).toEqual(new Set(["met@partner.com"]));
  });
});

describe("the assembled snapshot", () => {
  it("orders folders by priority, highest first", async () => {
    fake.seed("gmail_accounts", [{ id: ACC, user_id: USER, email_address: "me@example.com" }]);
    fake.seed("folders", [
      { id: "low", name: "Low", gmail_account_id: ACC, priority: 1 },
      { id: "high", name: "High", gmail_account_id: ACC, priority: 9 },
      { id: "mid", name: "Mid", gmail_account_id: ACC, priority: 5 },
    ]);
    const ctx = await loadAccountContext(ACC, USER);
    expect(ctx.folders.map((f) => f.id)).toEqual(["high", "mid", "low"]);
  });

  it("carries the connected address through verbatim for surface-rule identity", async () => {
    seedAccount();
    const ctx = await loadAccountContext(ACC, USER);
    expect(ctx.accountEmail).toBe("Me@Example.com");
  });

  it("keys sender groups by lowercased address and unions a contact's groups", async () => {
    seedAccount();
    // The production select embeds contacts!inner(email,user_id); seed the
    // joined shape directly, since the fake resolves aliased embeds only.
    fake.seedRaw("contact_group_members", [
      { group_id: "g-1", user_id: USER, contacts: { email: "Boss@Acme.com", user_id: USER } },
      { group_id: "g-2", user_id: USER, contacts: { email: "boss@acme.com", user_id: USER } },
      { group_id: "g-3", user_id: USER, contacts: { email: null, user_id: USER } },
      {
        group_id: "g-9",
        user_id: OTHER_USER,
        contacts: { email: "them@x.test", user_id: OTHER_USER },
      },
    ]);

    const ctx = await loadAccountContext(ACC, USER);
    expect([...ctx.senderGroups.keys()]).toEqual(["boss@acme.com"]);
    expect(ctx.senderGroups.get("boss@acme.com")).toEqual(new Set(["g-1", "g-2"]));
  });

  it("attaches at most five folder examples per folder", async () => {
    seedAccount();
    fake.seed(
      "folder_examples",
      Array.from({ length: 7 }, (_, i) => ({ folder_id: "f-1", from_addr: `s${i}@x.test` })),
    );
    const ctx = await loadAccountContext(ACC, USER);
    expect(ctx.enrichedFolders).toHaveLength(1);
    expect(ctx.enrichedFolders[0]).toMatchObject({
      id: "f-1",
      name: "Receipts",
      ai_rule: "receipts",
    });
    expect(ctx.enrichedFolders[0]!.examples).toHaveLength(5);
  });

  it("gives a folder with no examples an empty list rather than dropping it", async () => {
    seedAccount();
    const ctx = await loadAccountContext(ACC, USER);
    expect(ctx.enrichedFolders[0]!.examples).toEqual([]);
  });
});
