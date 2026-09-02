// Unit tests for the meeting calendar server functions
// (src/lib/meetings/calendar.functions.ts). The inline "is this account
// mine?" read is repeated at five call sites; each is covered here.
// Ownership itself is enforced by RLS on `context.supabase`, so denial is
// expressed as "with only the rows RLS would expose, the call fails and
// writes nothing" (`// RLS-RELIANCE:` below).
//
// Also pinned: the default calendar selection (primary on, others off)
// applies only until stored rows exist; a Google failure degrades to an
// error field rather than throwing; and the cross-account listings skip an
// inbox that needs reconnecting instead of dropping its meetings silently.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { callWithRlsClient } from "@/lib/__fixtures__/rls-server-fn";
import { NeedsReconnectError } from "../google-oauth.server";
import type { UpcomingCalendarEvent, CalendarWindowEvent } from "../meetings-autojoin.server";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));

const {
  listGoogleCalendars,
  listUpcomingCalendarEventsForAccount,
  listCalendarEventsWindow,
  upsertEventExclusion,
  logError,
} = vi.hoisted(() => ({
  listGoogleCalendars: vi.fn<typeof import("../meetings-autojoin.server").listGoogleCalendars>(),
  listUpcomingCalendarEventsForAccount:
    vi.fn<typeof import("../meetings-autojoin.server").listUpcomingCalendarEventsForAccount>(),
  listCalendarEventsWindow:
    vi.fn<typeof import("../meetings-autojoin.server").listCalendarEventsWindow>(),
  upsertEventExclusion: vi.fn<typeof import("../meetings-autojoin.server").upsertEventExclusion>(),
  logError: vi.fn(),
}));

vi.mock("../meetings-autojoin.server", () => ({
  listGoogleCalendars,
  listUpcomingCalendarEventsForAccount,
  listCalendarEventsWindow,
  upsertEventExclusion,
}));
vi.mock("../log.server", () => ({ logError, logInfo: vi.fn(), logAudit: vi.fn() }));

import {
  listAccountCalendars,
  listAllUpcomingCalendarEvents,
  listRecentUnrecordedEvents,
  listUpcomingCalendarEvents,
  saveCalendarSelections,
  setEventExclusion,
  setEventRecordingMode,
} from "./calendar.functions";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT = "22222222-2222-4222-8222-222222222222";
const FOREIGN_ACCOUNT = "33333333-3333-4333-8333-333333333333";
const EVENT = "event-abc";

const call = <F extends (args: never) => Promise<unknown>>(fn: F) =>
  callWithRlsClient(fn, { fake });

function upcoming(overrides: Partial<UpcomingCalendarEvent>): UpcomingCalendarEvent {
  return {
    id: "e1",
    title: null,
    start: null,
    hasMeetingLink: true,
    scheduled: false,
    excluded: false,
    recordMode: "bot",
    blocked: false,
    blockedBy: null,
    declined: false,
    meetingId: null,
    meetingStatus: null,
    hasRecording: false,
    canResendBot: false,
    ...overrides,
  };
}

function windowEvent(overrides: Partial<CalendarWindowEvent>): CalendarWindowEvent {
  return {
    ...upcoming({}),
    end: null,
    willRecord: false,
    skipReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  fake.reset();
  listGoogleCalendars.mockResolvedValue([]);
  listUpcomingCalendarEventsForAccount.mockResolvedValue([]);
  listCalendarEventsWindow.mockResolvedValue([]);
  upsertEventExclusion.mockResolvedValue(null);
});

describe("listAccountCalendars", () => {
  // RLS-RELIANCE: gmail_accounts is read through context.supabase.
  it("refuses an account the caller cannot see and never calls Google", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER, calendar_access: true }]);

    await expect(
      call(listAccountCalendars)({ data: { accountId: FOREIGN_ACCOUNT } }),
    ).rejects.toThrow("Account not found");
    expect(listGoogleCalendars).not.toHaveBeenCalled();
  });

  it("reports no calendar access without calling Google", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER, calendar_access: false }]);

    await expect(
      call(listAccountCalendars)({ data: { accountId: ACCOUNT } }),
    ).resolves.toStrictEqual({ calendarAccess: false, calendars: [] });
    expect(listGoogleCalendars).not.toHaveBeenCalled();
  });

  it("defaults to primary-on when no selection rows exist yet", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER, calendar_access: true }]);
    listGoogleCalendars.mockResolvedValue([
      { id: "cal-primary", summary: "Work", primary: true },
      { id: "cal-other", summary: "Birthdays", primary: false },
    ]);

    const result = await call(listAccountCalendars)({ data: { accountId: ACCOUNT } });

    expect(result).toStrictEqual({
      calendarAccess: true,
      calendars: [
        { id: "cal-primary", summary: "Work", primary: true, enabled: true },
        { id: "cal-other", summary: "Birthdays", primary: false, enabled: false },
      ],
    });
  });

  it("once selections exist, an unlisted calendar is off even if it is primary", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER, calendar_access: true }]);
    fake.seed("meeting_calendar_selections", [
      { gmail_account_id: ACCOUNT, calendar_id: "cal-other", enabled: true },
    ]);
    listGoogleCalendars.mockResolvedValue([
      { id: "cal-primary", summary: "Work", primary: true },
      { id: "cal-other", summary: "Birthdays", primary: false },
    ]);

    const result = await call(listAccountCalendars)({ data: { accountId: ACCOUNT } });

    expect(result.calendars.map((c) => [c.id, c.enabled])).toStrictEqual([
      ["cal-primary", false],
      ["cal-other", true],
    ]);
  });

  it("degrades to an error field when Google fails, rather than throwing", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER, calendar_access: true }]);
    listGoogleCalendars.mockRejectedValue(new Error("Calendar list 503"));

    const result = await call(listAccountCalendars)({ data: { accountId: ACCOUNT } });

    expect(result).toStrictEqual({
      calendarAccess: true,
      calendars: [],
      error: "Couldn't load your calendars right now.",
    });
    expect(logError.mock.calls[0]?.[0]).toBe("meeting_list_calendars_failed");
  });
});

describe("saveCalendarSelections", () => {
  // RLS-RELIANCE: the account read runs on context.supabase.
  it("refuses an account the caller cannot see and writes nothing", async () => {
    await expect(
      call(saveCalendarSelections)({
        data: {
          accountId: FOREIGN_ACCOUNT,
          calendars: [{ calendarId: "cal-1", enabled: true }],
        },
      }),
    ).rejects.toThrow("Account not found");
    expect(writeCount(fake)).toBe(0);
  });

  it("upserts every calendar stamped with the caller's id, keyed on account+calendar", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER }]);

    const result = await call(saveCalendarSelections)({
      data: {
        accountId: ACCOUNT,
        calendars: [
          { calendarId: "cal-1", calendarSummary: "Work", enabled: true },
          { calendarId: "cal-2", enabled: false },
        ],
      },
    });

    expect(result).toStrictEqual({ saved: 2 });
    expect(fake.calls.upserts.map((w) => [w.table, w.payload, w.options])).toStrictEqual([
      [
        "meeting_calendar_selections",
        [
          {
            user_id: TEST_USER,
            gmail_account_id: ACCOUNT,
            calendar_id: "cal-1",
            calendar_summary: "Work",
            enabled: true,
          },
          {
            user_id: TEST_USER,
            gmail_account_id: ACCOUNT,
            calendar_id: "cal-2",
            calendar_summary: null,
            enabled: false,
          },
        ],
        { onConflict: "gmail_account_id,calendar_id" },
      ],
    ]);
  });

  it("surfaces a rejected upsert", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER }]);
    fake.onUpsert("meeting_calendar_selections", () => ({ message: "upsert denied" }));

    await expect(
      call(saveCalendarSelections)({
        data: { accountId: ACCOUNT, calendars: [{ calendarId: "cal-1", enabled: true }] },
      }),
    ).rejects.toThrow("upsert denied");
  });
});

describe("listUpcomingCalendarEvents", () => {
  // RLS-RELIANCE: the account read runs on context.supabase.
  it("refuses an account the caller cannot see and never reads Google", async () => {
    await expect(
      call(listUpcomingCalendarEvents)({ data: { accountId: FOREIGN_ACCOUNT } }),
    ).rejects.toThrow("Account not found");
    expect(listUpcomingCalendarEventsForAccount).not.toHaveBeenCalled();
  });

  it("reports the declined-meeting preference even without calendar access", async () => {
    fake.seed("gmail_accounts", [
      {
        id: ACCOUNT,
        user_id: TEST_USER,
        calendar_access: false,
        record_declined_meetings: true,
      },
    ]);

    await expect(
      call(listUpcomingCalendarEvents)({ data: { accountId: ACCOUNT } }),
    ).resolves.toStrictEqual({ calendarAccess: false, events: [], recordDeclined: true });
    expect(listUpcomingCalendarEventsForAccount).not.toHaveBeenCalled();
  });

  it("passes the caller's id through to the event lister", async () => {
    fake.seed("gmail_accounts", [
      {
        id: ACCOUNT,
        user_id: TEST_USER,
        calendar_access: true,
        record_declined_meetings: false,
      },
    ]);
    const event = upcoming({ id: EVENT, title: "Standup" });
    listUpcomingCalendarEventsForAccount.mockResolvedValue([event]);

    const result = await call(listUpcomingCalendarEvents)({ data: { accountId: ACCOUNT } });

    expect(result).toStrictEqual({ calendarAccess: true, events: [event], recordDeclined: false });
    expect(listUpcomingCalendarEventsForAccount.mock.calls).toStrictEqual([[ACCOUNT, TEST_USER]]);
  });

  it("degrades to an error field when the lister fails", async () => {
    fake.seed("gmail_accounts", [
      { id: ACCOUNT, user_id: TEST_USER, calendar_access: true, record_declined_meetings: false },
    ]);
    listUpcomingCalendarEventsForAccount.mockRejectedValue(new Error("Calendar 500"));

    await expect(
      call(listUpcomingCalendarEvents)({ data: { accountId: ACCOUNT } }),
    ).resolves.toStrictEqual({
      calendarAccess: true,
      events: [],
      recordDeclined: false,
      error: "Couldn't load your calendar events right now.",
    });
    expect(logError.mock.calls[0]?.[0]).toBe("meeting_list_events_failed");
  });
});

describe("listAllUpcomingCalendarEvents", () => {
  function seedTwoAccounts(overrides?: { needsReconnect?: boolean }) {
    fake.seed("gmail_accounts", [
      {
        id: ACCOUNT,
        user_id: TEST_USER,
        email_address: "a@acme.com",
        calendar_access: true,
        auto_record_meetings: true,
        needs_reconnect: overrides?.needsReconnect ?? false,
      },
      {
        id: OTHER_ACCOUNT,
        user_id: TEST_USER,
        email_address: "b@acme.com",
        calendar_access: true,
        auto_record_meetings: true,
        needs_reconnect: false,
      },
    ]);
  }

  it("reports no calendar access when no inbox has auto-record enabled", async () => {
    fake.seed("gmail_accounts", [
      {
        id: ACCOUNT,
        user_id: TEST_USER,
        calendar_access: true,
        auto_record_meetings: false,
        needs_reconnect: false,
      },
    ]);

    await expect(call(listAllUpcomingCalendarEvents)()).resolves.toStrictEqual({
      calendarAccess: false,
      events: [],
      accountsNeedingReconnect: [],
    });
    expect(listUpcomingCalendarEventsForAccount).not.toHaveBeenCalled();
  });

  it("merges both inboxes' events into one start-sorted list", async () => {
    seedTwoAccounts();
    listUpcomingCalendarEventsForAccount.mockImplementation(async (accountId) =>
      accountId === ACCOUNT
        ? [upcoming({ id: "late", start: "2026-03-01T15:00:00Z" })]
        : [upcoming({ id: "early", start: "2026-03-01T09:00:00Z" })],
    );

    const result = await call(listAllUpcomingCalendarEvents)();

    expect(result.events.map((e) => [e.id, e.accountId, e.accountEmail])).toStrictEqual([
      ["early", OTHER_ACCOUNT, "b@acme.com"],
      ["late", ACCOUNT, "a@acme.com"],
    ]);
    expect(result.accountsNeedingReconnect).toStrictEqual([]);
  });

  it("surfaces a known-stale inbox for reconnect without reading it", async () => {
    seedTwoAccounts({ needsReconnect: true });

    const result = await call(listAllUpcomingCalendarEvents)();

    expect(result.accountsNeedingReconnect).toStrictEqual([{ id: ACCOUNT, email: "a@acme.com" }]);
    expect(listUpcomingCalendarEventsForAccount.mock.calls).toStrictEqual([
      [OTHER_ACCOUNT, TEST_USER],
    ]);
  });

  it("turns a dead OAuth grant into a reconnect prompt and logs anything else", async () => {
    seedTwoAccounts();
    listUpcomingCalendarEventsForAccount.mockImplementation(async (accountId) => {
      if (accountId === ACCOUNT) throw new NeedsReconnectError(ACCOUNT, "invalid_grant");
      throw new Error("Calendar 500");
    });

    const result = await call(listAllUpcomingCalendarEvents)();

    expect(result.events).toStrictEqual([]);
    expect(result.accountsNeedingReconnect).toStrictEqual([{ id: ACCOUNT, email: "a@acme.com" }]);
    expect(logError.mock.calls.map((c) => c[0])).toStrictEqual(["meeting_list_all_events_failed"]);
  });
});

describe("listRecentUnrecordedEvents", () => {
  it("keeps only events that never produced a meeting row", async () => {
    fake.seed("gmail_accounts", [
      {
        id: ACCOUNT,
        user_id: TEST_USER,
        email_address: "a@acme.com",
        calendar_access: true,
        auto_record_meetings: true,
        needs_reconnect: false,
      },
    ]);
    listCalendarEventsWindow.mockResolvedValue([
      windowEvent({ id: "recorded", meetingId: "m-1", start: "2026-03-01T09:00:00Z" }),
      windowEvent({ id: "missed", meetingId: null, start: "2026-03-01T08:00:00Z" }),
    ]);

    const result = await call(listRecentUnrecordedEvents)();

    expect(result.events.map((e) => [e.id, e.accountId, e.accountEmail])).toStrictEqual([
      ["missed", ACCOUNT, "a@acme.com"],
    ]);
    expect(listCalendarEventsWindow.mock.calls).toStrictEqual([[ACCOUNT, TEST_USER, 7, 0]]);
  });

  it("stays quiet about a dead OAuth grant but logs other failures", async () => {
    fake.seed("gmail_accounts", [
      {
        id: ACCOUNT,
        user_id: TEST_USER,
        email_address: null,
        calendar_access: true,
        auto_record_meetings: true,
        needs_reconnect: false,
      },
    ]);

    listCalendarEventsWindow.mockRejectedValue(new NeedsReconnectError(ACCOUNT, "invalid_grant"));
    await expect(call(listRecentUnrecordedEvents)()).resolves.toStrictEqual({ events: [] });
    expect(logError).not.toHaveBeenCalled();

    listCalendarEventsWindow.mockRejectedValue(new Error("Calendar 500"));
    await call(listRecentUnrecordedEvents)();
    expect(logError.mock.calls.map((c) => c[0])).toStrictEqual([
      "meeting_list_recent_unrecorded_failed",
    ]);
  });
});

describe("setEventExclusion", () => {
  // RLS-RELIANCE: the account read runs on context.supabase.
  it("refuses an account the caller cannot see and writes nothing", async () => {
    await expect(
      call(setEventExclusion)({
        data: { accountId: FOREIGN_ACCOUNT, calendarEventId: EVENT, excluded: true },
      }),
    ).rejects.toThrow("Account not found");
    expect(upsertEventExclusion).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("records an exclusion in 'off' mode through the shared writer", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER }]);

    const result = await call(setEventExclusion)({
      data: { accountId: ACCOUNT, calendarEventId: EVENT, excluded: true },
    });

    expect(result).toStrictEqual({ excluded: true });
    expect(upsertEventExclusion.mock.calls[0]?.slice(1)).toStrictEqual([
      { userId: TEST_USER, accountId: ACCOUNT, calendarEventId: EVENT },
      "off",
    ]);
  });

  it("deletes the exclusion scoped to the caller and the event when re-included", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER }]);

    const result = await call(setEventExclusion)({
      data: { accountId: ACCOUNT, calendarEventId: EVENT, excluded: false },
    });

    expect(result).toStrictEqual({ excluded: false });
    expect(fake.calls.deletes.map((w) => [w.table, w.filters])).toStrictEqual([
      [
        "meeting_autojoin_exclusions",
        [
          { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
          { op: "eq", col: "calendar_event_id", value: EVENT, extra: undefined },
        ],
      ],
    ]);
  });

  it("surfaces an exclusion write failure", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER }]);
    upsertEventExclusion.mockResolvedValue("upsert denied");

    await expect(
      call(setEventExclusion)({
        data: { accountId: ACCOUNT, calendarEventId: EVENT, excluded: true },
      }),
    ).rejects.toThrow("upsert denied");
  });
});

describe("setEventRecordingMode", () => {
  // RLS-RELIANCE: the account read runs on context.supabase.
  it("refuses an account the caller cannot see and writes nothing", async () => {
    await expect(
      call(setEventRecordingMode)({
        data: { accountId: FOREIGN_ACCOUNT, calendarEventId: EVENT, mode: "in_person" },
      }),
    ).rejects.toThrow("Account not found");
    expect(upsertEventExclusion).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("clears the exclusion when the bot is put back in charge", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER }]);

    const result = await call(setEventRecordingMode)({
      data: { accountId: ACCOUNT, calendarEventId: EVENT, mode: "bot" },
    });

    expect(result).toStrictEqual({ mode: "bot" });
    expect(upsertEventExclusion).not.toHaveBeenCalled();
    expect(fake.calls.deletes).toHaveLength(1);
  });

  it("remembers 'in_person' as the reason the bot stays away", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER }]);

    const result = await call(setEventRecordingMode)({
      data: { accountId: ACCOUNT, calendarEventId: EVENT, mode: "in_person" },
    });

    expect(result).toStrictEqual({ mode: "in_person" });
    expect(upsertEventExclusion.mock.calls[0]?.[2]).toBe("in_person");
    expect(fake.calls.deletes).toHaveLength(0);
  });

  it("surfaces a failing delete on the bot path", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER }]);
    fake.onDelete("meeting_autojoin_exclusions", () => ({ message: "delete denied" }));

    await expect(
      call(setEventRecordingMode)({
        data: { accountId: ACCOUNT, calendarEventId: EVENT, mode: "bot" },
      }),
    ).rejects.toThrow("delete denied");
  });
});
