// Tests for the on-demand repair helpers (repullContact / backfillMultiEmails).
// The mapper stays REAL; getPerson is stubbed while PeopleApiError is kept as
// the REAL class (importOriginal) so status-based branching works.
//
// The core invariant is that repair is strictly ADDITIVE: it may insert
// emails/phones that exist in Google but are missing locally, and it must
// never delete rows, never flip an existing primary, and never dedupe-miss
// on case (emails) or formatting (phones).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import type { Person } from "./mapper";

const fake = makeSupabaseFake();
const getPersonMock = vi.fn();
const logInfoMock = vi.fn();
const logErrorMock = vi.fn();

// CRITICAL: factories must not touch module-level consts at factory time
// (vi.mock hoisting) — every property access is deferred into method bodies.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));
vi.mock("@/lib/google-oauth.server", () => ({
  getAccessToken: async () => "test-token",
  NeedsReconnectError: class NeedsReconnectError extends Error {},
}));
vi.mock("./people-client.server", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./people-client.server")>();
  return {
    ...orig, // keeps the REAL PeopleApiError so instanceof/status checks work
    getPerson: (accountId: string, resourceName: string) => getPersonMock(accountId, resourceName),
  };
});
vi.mock("@/lib/log.server", () => ({
  logInfo: (...args: unknown[]) => logInfoMock(...args),
  logError: (...args: unknown[]) => logErrorMock(...args),
}));

import { repullContact, backfillMultiEmails } from "./repair.server";
import { PeopleApiError } from "./people-client.server";

const USER = "user-1";
const ACC = "acct-1";
const CT1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESOURCE = "people/abc123";

function seedLink(): void {
  fake.seed("google_contact_links", [
    { user_id: USER, contact_id: CT1, resource_name: RESOURCE, gmail_account_id: ACC },
  ]);
}

function writesTo(kind: "inserts" | "updates" | "deletes" | "upserts", table: string) {
  return fake.calls[kind].filter((w) => w.table === table);
}

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  fake.seed("google_contact_links", []);
  fake.seed("contact_emails", []);
  fake.seed("contact_phones", []);
});

describe("repullContact early-outs", () => {
  it("returns not_linked without any People API call when no link exists", async () => {
    const res = await repullContact(USER, CT1);
    expect(res).toEqual({ ok: false, emailsAdded: 0, phonesAdded: 0, reason: "not_linked" });
    expect(getPersonMock).not.toHaveBeenCalled();
  });

  it("maps a Google 404 to not_found_in_google", async () => {
    seedLink();
    getPersonMock.mockRejectedValue(new PeopleApiError("gone", 404));
    const res = await repullContact(USER, CT1);
    expect(res).toEqual({
      ok: false,
      emailsAdded: 0,
      phonesAdded: 0,
      reason: "not_found_in_google",
    });
  });

  it("surfaces other fetch failures as the error message and logs them", async () => {
    seedLink();
    getPersonMock.mockRejectedValue(new PeopleApiError("People API 500 on people/abc123", 500));
    const res = await repullContact(USER, CT1);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("People API 500 on people/abc123");
    expect(logErrorMock).toHaveBeenCalledWith(
      "google_contacts.repair.get_failed",
      expect.objectContaining({ contactId: CT1 }),
      expect.anything(),
    );
    // A failed fetch must not touch the link or any local rows.
    expect(fake.calls.inserts).toHaveLength(0);
    expect(fake.calls.updates).toHaveLength(0);
  });
});

describe("repullContact additive merge", () => {
  it("inserts only remote-only emails, deduped case-insensitively, never deleting or re-priming", async () => {
    seedLink();
    fake.seed("contact_emails", [
      { contact_id: CT1, address: "existing@example.com", position: 2, is_primary: true },
    ]);
    getPersonMock.mockResolvedValue({
      etag: "fresh-etag",
      emailAddresses: [
        { value: "Existing@Example.com" }, // case-variant of a local row → skipped
        { value: "new@example.org", type: "WORK" },
      ],
    } as Person);

    const res = await repullContact(USER, CT1);

    expect(res).toEqual({ ok: true, emailsAdded: 1, phonesAdded: 0 });
    // Additive-only invariant: zero deletes, ever.
    expect(fake.calls.deletes).toHaveLength(0);
    const inserts = writesTo("inserts", "contact_emails");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toEqual([
      {
        user_id: USER,
        contact_id: CT1,
        label: "work",
        address: "new@example.org",
        is_primary: false, // the contact already has a primary → never flipped
        position: 3, // continues after the existing max position
      },
    ]);
  });

  it("dedupes phones on normalized digits and promotes a primary only when none exists", async () => {
    seedLink();
    fake.seed("contact_phones", [
      { contact_id: CT1, number: "+1 (555) 123-4567", position: 0, is_primary: false },
    ]);
    getPersonMock.mockResolvedValue({
      etag: "fresh-etag",
      phoneNumbers: [
        { value: "+1 555 123 4567" }, // same digits, different formatting → skipped
        { value: "+1 555 999 0000", type: "mobile" },
      ],
    } as Person);

    const res = await repullContact(USER, CT1);

    expect(res).toEqual({ ok: true, emailsAdded: 0, phonesAdded: 1 });
    const inserts = writesTo("inserts", "contact_phones");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toEqual([
      {
        user_id: USER,
        contact_id: CT1,
        label: "mobile",
        number: "+1 555 999 0000",
        is_primary: true, // no existing primary → the first new row is promoted
        position: 1,
      },
    ]);
  });

  it("freshens the link (etag + last_synced_at) after a successful repull", async () => {
    seedLink();
    getPersonMock.mockResolvedValue({ etag: "fresh-etag" } as Person);

    const res = await repullContact(USER, CT1);

    expect(res.ok).toBe(true);
    const updates = writesTo("updates", "google_contact_links");
    expect(updates).toHaveLength(1);
    const payload = updates[0].payload as Record<string, unknown>;
    expect(payload.etag).toBe("fresh-etag");
    expect(typeof payload.last_synced_at).toBe("string");
    expect(updates[0].filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "gmail_account_id", value: ACC },
        { op: "eq", col: "resource_name", value: RESOURCE },
      ]),
    );
  });
});

describe("backfillMultiEmails", () => {
  it("scans every link, counting 404s and hard failures separately from clean rows", async () => {
    fake.seed("google_contact_links", [
      { user_id: USER, contact_id: "c-ok", resource_name: "people/ok", gmail_account_id: ACC },
      { user_id: USER, contact_id: "c-404", resource_name: "people/gone", gmail_account_id: ACC },
      { user_id: USER, contact_id: "c-boom", resource_name: "people/boom", gmail_account_id: ACC },
    ]);
    getPersonMock.mockImplementation(async (_acc: string, resource: string) => {
      if (resource === "people/gone") throw new PeopleApiError("gone", 404);
      if (resource === "people/boom") throw new PeopleApiError("boom", 500);
      return { etag: "e" } as Person;
    });

    const res = await backfillMultiEmails(USER, ACC);

    expect(res).toEqual({
      contactsScanned: 3,
      contactsUpdated: 0,
      emailsAdded: 0,
      phonesAdded: 0,
      failed: 2,
    });
    // 404s are expected churn (deleted upstream) and stay quiet; only the
    // hard failure is logged.
    const itemFailures = logErrorMock.mock.calls.filter(
      (c) => c[0] === "google_contacts.repair.backfill_item_failed",
    );
    expect(itemFailures).toHaveLength(1);
    expect(itemFailures[0][1]).toMatchObject({ contact_id: "c-boom" });
  });
});
