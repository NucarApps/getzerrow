// Unit tests for the calendar guard server functions
// (src/lib/calendar.functions.ts). These run on the service-role client, so
// the `assertOwnsAccount` guard is the only thing between a caller and
// another tenant's calendar — every entry point that takes an accountId is
// held to `expectDeniedCrossUser` here.
//
// Also pinned: enabling the guard invalidates the cached account context
// and kicks an initial sync only when calendar access exists; a Google
// failure is reported as a typed reason rather than thrown at the UI.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";
import { CalendarApiError } from "./calendar.server";

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

const { syncCalendarContacts, listCalendarPeople, invalidateAccountContext, logError } = vi.hoisted(
  () => ({
    syncCalendarContacts: vi.fn<typeof import("./calendar.server").syncCalendarContacts>(),
    listCalendarPeople: vi.fn<typeof import("./calendar.server").listCalendarPeople>(),
    invalidateAccountContext:
      vi.fn<typeof import("./sync/account-context").invalidateAccountContext>(),
    logError: vi.fn(),
  }),
);
vi.mock("./calendar.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./calendar.server")>();
  return { ...actual, syncCalendarContacts, listCalendarPeople };
});
vi.mock("./sync/account-context", () => ({ invalidateAccountContext }));
vi.mock("./log.server", () => ({ logError, logInfo: vi.fn(), logAudit: vi.fn() }));

import {
  getCalendarGuardStatus,
  listMeetingPeople,
  setCalendarGuard,
  syncCalendarNow,
} from "./calendar.functions";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT = "22222222-2222-4222-8222-222222222222";
const ATTACKER = "attacker-user";
const DENIED = "Not authorized for this account";

function seedAccount(overrides?: {
  ownerId?: string;
  calendarAccess?: boolean;
  guardEnabled?: boolean;
  syncedAt?: string | null;
  syncError?: string | null;
}) {
  fake.seed("gmail_accounts", [
    {
      id: ACCOUNT,
      user_id: overrides?.ownerId ?? TEST_USER,
      calendar_access: overrides?.calendarAccess ?? true,
      calendar_guard_enabled: overrides?.guardEnabled ?? false,
      calendar_synced_at: overrides?.syncedAt ?? null,
      calendar_sync_error: overrides?.syncError ?? null,
    },
  ]);
}

function person(overrides: {
  email: string;
  name?: string | null;
  meetingAt?: string | null;
  eventTitle?: string | null;
}) {
  return {
    email: overrides.email,
    name: overrides.name ?? null,
    meetingAt: overrides.meetingAt ?? null,
    eventTitle: overrides.eventTitle ?? null,
  };
}

beforeEach(() => {
  fake.reset();
  syncCalendarContacts.mockResolvedValue({ contacts: 3, pages: 1, truncated: false });
  listCalendarPeople.mockResolvedValue([]);
});

describe("getCalendarGuardStatus", () => {
  it("denies another user's account", async () => {
    seedAccount();
    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(getCalendarGuardStatus, ATTACKER)({ data: { accountId: ACCOUNT } }),
      rejects: DENIED,
    });
  });

  it("reports the guard state, sync stamp and cached contact count", async () => {
    seedAccount({
      guardEnabled: true,
      syncedAt: "2026-02-28T00:00:00Z",
      syncError: "Google is rate-limiting calendar requests right now.",
    });
    fake.seed("calendar_contacts", [
      { id: "c1", gmail_account_id: ACCOUNT, email_address: "a@partner.com" },
      { id: "c2", gmail_account_id: ACCOUNT, email_address: "b@partner.com" },
      { id: "c3", gmail_account_id: OTHER_ACCOUNT, email_address: "c@partner.com" },
    ]);

    await expect(getCalendarGuardStatus({ data: { accountId: ACCOUNT } })).resolves.toStrictEqual({
      enabled: true,
      calendarAccess: true,
      syncedAt: "2026-02-28T00:00:00Z",
      contactCount: 2,
      lastError: "Google is rate-limiting calendar requests right now.",
    });
    expect(writeCount(fake)).toBe(0);
  });
});

describe("setCalendarGuard", () => {
  it("denies another user's account without touching the guard flag", async () => {
    seedAccount();
    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(setCalendarGuard, ATTACKER)({ data: { accountId: ACCOUNT, enabled: true } }),
      rejects: DENIED,
    });
    expect(syncCalendarContacts).not.toHaveBeenCalled();
  });

  it("enables the guard, refreshes the cached context and runs an initial sync", async () => {
    seedAccount();

    const result = await setCalendarGuard({ data: { accountId: ACCOUNT, enabled: true } });

    expect(result).toStrictEqual({
      enabled: true,
      calendarAccess: true,
      synced: { contacts: 3 },
      syncReason: null,
    });
    expect(fake.calls.updates.map((w) => [w.table, w.payload, w.filters])).toStrictEqual([
      [
        "gmail_accounts",
        { calendar_guard_enabled: true },
        [{ op: "eq", col: "id", value: ACCOUNT, extra: undefined }],
      ],
    ]);
    expect(syncCalendarContacts.mock.calls).toStrictEqual([[ACCOUNT, TEST_USER]]);
    // Once after the flag flip, once after the sync populated the cache.
    expect(invalidateAccountContext.mock.calls).toStrictEqual([[ACCOUNT], [ACCOUNT]]);
  });

  it("skips the initial sync when calendar access has not been granted", async () => {
    seedAccount({ calendarAccess: false });

    const result = await setCalendarGuard({ data: { accountId: ACCOUNT, enabled: true } });

    expect(result).toStrictEqual({
      enabled: true,
      calendarAccess: false,
      synced: null,
      syncReason: null,
    });
    expect(syncCalendarContacts).not.toHaveBeenCalled();
  });

  it("does not sync when the guard is being switched off", async () => {
    seedAccount({ guardEnabled: true });

    const result = await setCalendarGuard({ data: { accountId: ACCOUNT, enabled: false } });

    expect(result.enabled).toBe(false);
    expect(fake.calls.updates[0]?.payload).toStrictEqual({ calendar_guard_enabled: false });
    expect(syncCalendarContacts).not.toHaveBeenCalled();
  });

  it("still enables the guard when the initial sync fails, reporting the reason", async () => {
    seedAccount();
    syncCalendarContacts.mockRejectedValue(
      new CalendarApiError("disabled", 403, "accessNotConfigured"),
    );

    const result = await setCalendarGuard({ data: { accountId: ACCOUNT, enabled: true } });

    expect(result).toStrictEqual({
      enabled: true,
      calendarAccess: true,
      synced: null,
      syncReason: "api_disabled",
    });
    expect(logError.mock.calls[0]?.[0]).toBe("calendar.initial_sync_failed");
  });

  it("reports an unrecognized sync failure as unknown", async () => {
    seedAccount();
    syncCalendarContacts.mockRejectedValue(new Error("boom"));

    const result = await setCalendarGuard({ data: { accountId: ACCOUNT, enabled: true } });

    expect(result.syncReason).toBe("unknown");
  });

  it("surfaces a rejected flag update before attempting any sync", async () => {
    seedAccount();
    fake.onUpdate("gmail_accounts", () => ({ message: "update denied" }));

    await expect(setCalendarGuard({ data: { accountId: ACCOUNT, enabled: true } })).rejects.toThrow(
      "update denied",
    );
    expect(syncCalendarContacts).not.toHaveBeenCalled();
    expect(invalidateAccountContext).not.toHaveBeenCalled();
  });
});

describe("syncCalendarNow", () => {
  it("denies another user's account without calling Google", async () => {
    seedAccount();
    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(syncCalendarNow, ATTACKER)({ data: { accountId: ACCOUNT } }),
      rejects: DENIED,
    });
    expect(syncCalendarContacts).not.toHaveBeenCalled();
  });

  it("asks for a reconnect when calendar access is missing", async () => {
    seedAccount({ calendarAccess: false });

    await expect(syncCalendarNow({ data: { accountId: ACCOUNT } })).resolves.toStrictEqual({
      ok: false,
      reason: "reconnect",
    });
    expect(syncCalendarContacts).not.toHaveBeenCalled();
  });

  it("reports the contact count and whether the run was truncated", async () => {
    seedAccount();
    syncCalendarContacts.mockResolvedValue({ contacts: 42, pages: 12, truncated: true });

    await expect(syncCalendarNow({ data: { accountId: ACCOUNT } })).resolves.toStrictEqual({
      ok: true,
      contacts: 42,
      truncated: true,
    });
    expect(invalidateAccountContext.mock.calls).toStrictEqual([[ACCOUNT]]);
  });

  it("returns the typed reason for a Calendar failure without logging noise", async () => {
    seedAccount();
    syncCalendarContacts.mockRejectedValue(new CalendarApiError("scope", 401));

    await expect(syncCalendarNow({ data: { accountId: ACCOUNT } })).resolves.toStrictEqual({
      ok: false,
      reason: "reconnect",
    });
    expect(logError).not.toHaveBeenCalled();
    expect(invalidateAccountContext).not.toHaveBeenCalled();
  });

  it("logs and reports unknown for a failure that is not a Calendar error", async () => {
    seedAccount();
    syncCalendarContacts.mockRejectedValue(new Error("boom"));

    await expect(syncCalendarNow({ data: { accountId: ACCOUNT } })).resolves.toStrictEqual({
      ok: false,
      reason: "unknown",
    });
    expect(logError.mock.calls[0]?.[0]).toBe("calendar.sync_now_failed");
  });
});

describe("listMeetingPeople", () => {
  function seedTwoCalendarAccounts() {
    fake.seed("gmail_accounts", [
      { id: ACCOUNT, user_id: TEST_USER, calendar_access: true },
      { id: OTHER_ACCOUNT, user_id: TEST_USER, calendar_access: true },
      { id: "no-cal", user_id: TEST_USER, calendar_access: false },
    ]);
  }

  it("reports no calendar access when no inbox has granted it", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER, calendar_access: false }]);

    await expect(listMeetingPeople({ data: {} })).resolves.toStrictEqual({
      people: [],
      calendarAccess: false,
    });
    expect(listCalendarPeople).not.toHaveBeenCalled();
  });

  it("excludes people already in the caller's contacts", async () => {
    seedTwoCalendarAccounts();
    fake.seed("contacts", [
      { id: "k1", user_id: TEST_USER, email: "Known@Partner.com" },
      { id: "k2", user_id: "someone-else", email: "other@partner.com" },
    ]);
    listCalendarPeople.mockResolvedValue([
      person({ email: "known@partner.com" }),
      person({ email: "other@partner.com", name: "Other" }),
    ]);

    const result = await listMeetingPeople({ data: {} });

    expect(result.people.map((p) => p.email)).toStrictEqual(["other@partner.com"]);
  });

  it("merges the same person across inboxes, keeping the most recent past meeting", async () => {
    seedTwoCalendarAccounts();
    listCalendarPeople.mockImplementation(async (accountId) =>
      accountId === ACCOUNT
        ? [person({ email: "a@partner.com", meetingAt: "2026-01-01", eventTitle: "Kickoff" })]
        : [
            person({
              email: "a@partner.com",
              name: "Alice",
              meetingAt: "2026-02-01",
              eventTitle: "Review",
            }),
          ],
    );

    const result = await listMeetingPeople({ data: { when: "past" } });

    expect(result.people).toStrictEqual([
      { email: "a@partner.com", name: "Alice", meetingAt: "2026-02-01", eventTitle: "Review" },
    ]);
  });

  it("keeps the soonest meeting and sorts ascending for the upcoming view", async () => {
    seedTwoCalendarAccounts();
    listCalendarPeople.mockImplementation(async (accountId) =>
      accountId === ACCOUNT
        ? [person({ email: "a@partner.com", meetingAt: "2026-05-01", eventTitle: "Later" })]
        : [
            person({ email: "a@partner.com", meetingAt: "2026-03-05", eventTitle: "Sooner" }),
            person({ email: "b@partner.com", meetingAt: "2026-04-01" }),
          ],
    );

    const result = await listMeetingPeople({ data: { when: "upcoming" } });

    expect(result.people.map((p) => [p.email, p.meetingAt, p.eventTitle])).toStrictEqual([
      ["a@partner.com", "2026-03-05", "Sooner"],
      ["b@partner.com", "2026-04-01", null],
    ]);
    expect(listCalendarPeople.mock.calls).toStrictEqual([
      [ACCOUNT, { when: "upcoming" }],
      [OTHER_ACCOUNT, { when: "upcoming" }],
    ]);
  });

  it("sorts the past view most-recent first and applies the limit", async () => {
    seedTwoCalendarAccounts();
    listCalendarPeople.mockImplementation(async (accountId) =>
      accountId === ACCOUNT
        ? [
            person({ email: "old@partner.com", meetingAt: "2026-01-01" }),
            person({ email: "new@partner.com", meetingAt: "2026-02-01" }),
          ]
        : [],
    );

    const result = await listMeetingPeople({ data: { when: "past", limit: 1 } });

    expect(result.people.map((p) => p.email)).toStrictEqual(["new@partner.com"]);
  });

  it("filters case-insensitively on either the address or the name", async () => {
    seedTwoCalendarAccounts();
    listCalendarPeople.mockImplementation(async (accountId) =>
      accountId === ACCOUNT
        ? [
            person({ email: "alice@partner.com", name: "Alice Partner" }),
            person({ email: "bob@other.com", name: "Bob" }),
            person({ email: "carol@other.com", name: "Carol Alicent" }),
          ]
        : [],
    );

    const result = await listMeetingPeople({ data: { search: "  ALIC  " } });

    expect(result.people.map((p) => p.email)).toStrictEqual([
      "alice@partner.com",
      "carol@other.com",
    ]);
  });

  it("skips an inbox whose calendar read fails without losing the others", async () => {
    seedTwoCalendarAccounts();
    listCalendarPeople.mockImplementation(async (accountId) => {
      if (accountId === ACCOUNT) throw new CalendarApiError("scope", 401);
      return [person({ email: "b@partner.com" })];
    });

    const result = await listMeetingPeople({ data: {} });

    expect(result.people.map((p) => p.email)).toStrictEqual(["b@partner.com"]);
    expect(logError.mock.calls[0]?.[0]).toBe("calendar.list_people_failed");
  });
});
