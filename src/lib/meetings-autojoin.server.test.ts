// Tests for the pure event-filter / meeting-URL / resend predicates in
// src/lib/meetings-autojoin.server.ts, plus characterization of the
// scheduleUpcomingMeetingBots cron pass (bot dispatch, per-event dedup, and
// the Recall-failure path). Recall, Google OAuth, and the calendar API are all
// stubbed — no live HTTP.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));
vi.mock("./google-oauth.server", () => ({ getAccessToken: vi.fn() }));
vi.mock("./recall.server", () => ({ createBot: vi.fn(), detectPlatform: vi.fn() }));
vi.mock("./meetings.server", () => ({ loadBotConfig: vi.fn() }));
vi.mock("./log.server", () => ({ logError: vi.fn(), logInfo: vi.fn() }));

import {
  isHiddenEventType,
  isColorSkipped,
  isAllDayEvent,
  isDeclinedByUser,
  extractMeetingUrl,
  computeCanResendBot,
  scheduleUpcomingMeetingBots,
  loadEventFilterPrefs,
  resolveSelectedCalendarIds,
  listUpcomingCalendarEventsForAccount,
  listCalendarEventsWindow,
  listGoogleCalendars,
  upsertEventExclusion,
  findBlockedAttendeeForMeetingUrl,
  type EventFilterPrefs,
} from "./meetings-autojoin.server";
import { createBot, detectPlatform, type RecallBot } from "./recall.server";
import { getAccessToken } from "./google-oauth.server";
import { loadBotConfig } from "./meetings.server";
import { logError } from "./log.server";
import { DEFAULT_HIDDEN_TYPES } from "./meetings-helpers.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const prefs = (hidden: string[] = [], colors: string[] = []): EventFilterPrefs => ({
  hiddenEventTypes: new Set(hidden),
  colorSkip: new Set(colors),
});

describe("isHiddenEventType", () => {
  it("hides a non-default type the user chose to hide", () => {
    expect(isHiddenEventType({ eventType: "outOfOffice" }, prefs(["outOfOffice"]))).toBe(true);
  });
  it("never hides a default meeting", () => {
    expect(isHiddenEventType({ eventType: "default" }, prefs(["outOfOffice"]))).toBe(false);
    // Missing eventType is treated as "default".
    expect(isHiddenEventType({}, prefs(["outOfOffice"]))).toBe(false);
  });
  it("keeps a non-default type that is not in the hidden set", () => {
    expect(isHiddenEventType({ eventType: "focusTime" }, prefs(["outOfOffice"]))).toBe(false);
  });
});

describe("isColorSkipped", () => {
  it("skips an event whose color is in the skip set", () => {
    expect(isColorSkipped({ colorId: "5" }, prefs([], ["5"]))).toBe(true);
  });
  it("does not skip when the event has no color or the color is not listed", () => {
    expect(isColorSkipped({}, prefs([], ["5"]))).toBe(false);
    expect(isColorSkipped({ colorId: "3" }, prefs([], ["5"]))).toBe(false);
  });
});

describe("isAllDayEvent", () => {
  it("is true for a date-only (all-day) event", () => {
    expect(isAllDayEvent({ start: { date: "2026-07-23" } })).toBe(true);
    expect(isAllDayEvent({})).toBe(true);
  });
  it("is false for a timed event", () => {
    expect(isAllDayEvent({ start: { dateTime: "2026-07-23T10:00:00Z" } })).toBe(false);
  });
});

describe("isDeclinedByUser", () => {
  it("is true only when the self attendee declined", () => {
    expect(isDeclinedByUser({ attendees: [{ self: true, responseStatus: "declined" }] })).toBe(
      true,
    );
  });
  it("is false when the owner accepted, is absent, or there are no attendees", () => {
    expect(isDeclinedByUser({ attendees: [{ self: true, responseStatus: "accepted" }] })).toBe(
      false,
    );
    expect(
      isDeclinedByUser({ attendees: [{ email: "someone@x.com", responseStatus: "declined" }] }),
    ).toBe(false);
    expect(isDeclinedByUser({})).toBe(false);
  });
});

describe("extractMeetingUrl", () => {
  it("prefers a video conference entry point", () => {
    expect(
      extractMeetingUrl({
        conferenceData: {
          entryPoints: [
            { entryPointType: "phone", uri: "tel:+1555" },
            { entryPointType: "video", uri: "https://zoom.us/j/123" },
          ],
        },
      }),
    ).toBe("https://zoom.us/j/123");
  });
  it("falls back to the hangout link", () => {
    expect(extractMeetingUrl({ hangoutLink: "https://meet.google.com/abc-defg-hij" })).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
  });
  it("finds a URL embedded in the location or description", () => {
    expect(extractMeetingUrl({ location: "Join: https://teams.microsoft.com/l/meetup/xyz" })).toBe(
      "https://teams.microsoft.com/l/meetup/xyz",
    );
    expect(extractMeetingUrl({ description: "notes\nhttps://acme.zoom.us/j/999 see you" })).toBe(
      "https://acme.zoom.us/j/999",
    );
  });
  it("ignores unsupported and missing links", () => {
    expect(extractMeetingUrl({ location: "https://example.com/not-a-meeting" })).toBeNull();
    expect(extractMeetingUrl({})).toBeNull();
    // A non-video entry point with an unsupported URI is not returned.
    expect(
      extractMeetingUrl({
        conferenceData: { entryPoints: [{ entryPointType: "more", uri: "https://example.com/x" }] },
      }),
    ).toBeNull();
  });
});

describe("computeCanResendBot", () => {
  const base = {
    recallBotId: "bot-1",
    meetingUrl: "https://zoom.us/j/1",
    status: "failed",
    recordingUrl: null,
    scheduledStart: "2026-07-23T10:00:00Z",
    now: new Date("2026-07-23T10:01:00Z"), // 1 min after start
  };

  it("requires a bot id and a meeting url", () => {
    expect(computeCanResendBot({ ...base, recallBotId: null })).toBe(false);
    expect(computeCanResendBot({ ...base, meetingUrl: null })).toBe(false);
  });
  it("refuses once a recording exists", () => {
    expect(computeCanResendBot({ ...base, recordingUrl: "https://rec/1" })).toBe(false);
  });
  it("only resends for scheduled/joining/failed states", () => {
    expect(computeCanResendBot({ ...base, status: "done" })).toBe(false);
    expect(computeCanResendBot({ ...base, status: null })).toBe(false);
  });
  it("refuses when the meeting is more than two hours past start", () => {
    expect(computeCanResendBot({ ...base, now: new Date("2026-07-23T12:30:00Z") })).toBe(false);
  });
  it("holds scheduled/joining bots until the start grace passes, but surfaces failed immediately", () => {
    // scheduled, 1 min after start → within grace → hold.
    expect(computeCanResendBot({ ...base, status: "scheduled" })).toBe(false);
    // failed, same instant → surfaces immediately.
    expect(computeCanResendBot({ ...base, status: "failed" })).toBe(true);
    // scheduled, 10 min after start → past grace → resend.
    expect(
      computeCanResendBot({
        ...base,
        status: "scheduled",
        now: new Date("2026-07-23T10:10:00Z"),
      }),
    ).toBe(true);
  });
  it("resends when there is no scheduled start to gate on", () => {
    expect(computeCanResendBot({ ...base, status: "scheduled", scheduledStart: null })).toBe(true);
  });
});

describe("scheduleUpcomingMeetingBots", () => {
  const ACCOUNT = {
    id: "acct-1",
    user_id: "u1",
    email_address: "me@acme.com",
    auto_record_meetings: true,
    calendar_access: true,
    record_declined_meetings: false,
    needs_reconnect: false,
  };
  const EVENT = {
    id: "evt-1",
    summary: "Design review",
    start: { dateTime: "2026-09-01T12:10:00.000Z" },
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    attendees: [
      { email: "me@acme.com", self: true, responseStatus: "accepted" },
      { email: "Guest@Client.com", displayName: "Guest", responseStatus: "accepted" },
    ],
    organizer: { email: "boss@acme.com", displayName: "Boss" },
  };

  beforeEach(() => {
    // The global setup's restoreAllMocks doesn't clear vi.mock-factory fns.
    fake.reset();
    fake.seed("gmail_accounts", [ACCOUNT]);
    vi.mocked(getAccessToken).mockResolvedValue("google-token");
    vi.mocked(loadBotConfig).mockResolvedValue({
      botName: "Atzro Notetaker",
      chatMessage: null,
      chatResendOnJoin: true,
      imageB64: null,
      autoLeaveEnabled: true,
      autoLeaveMinutes: 30,
    });
    vi.mocked(createBot).mockResolvedValue({ id: "bot-new" } as RecallBot);
    vi.mocked(detectPlatform).mockReturnValue("google_meet");
    // Google Calendar events.list for the account's primary calendar.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ items: [EVENT] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  });

  it("sends a bot for an eligible event and records the meeting with its participants", async () => {
    const { scheduled } = await scheduleUpcomingMeetingBots("run-1");

    expect(scheduled).toBe(1);
    expect(createBot).toHaveBeenCalledTimes(1);
    expect(createBot).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        joinAt: "2026-09-01T12:10:00.000Z",
        botName: "Atzro Notetaker",
        everyoneLeftTimeoutSec: 1800,
        inCallNotRecordingTimeoutSec: 1800,
      }),
    );

    // The row is claimed before the bot exists (the unique index on
    // user_id + calendar_event_id is what makes the claim atomic), then
    // stamped with the bot id.
    const meetingInsert = fake.calls.inserts.find((i) => i.table === "meetings");
    expect(meetingInsert?.payload).toMatchObject({
      user_id: "u1",
      gmail_account_id: "acct-1",
      recall_bot_id: null,
      calendar_event_id: "evt-1",
      meeting_url: "https://meet.google.com/abc-defg-hij",
      platform: "google_meet",
      status: "scheduled",
      source: "calendar",
      scheduled_start: "2026-09-01T12:10:00.000Z",
    });
    const stamp = fake.calls.updates.find((u) => u.table === "meetings");
    expect(stamp?.payload).toEqual({ recall_bot_id: "bot-new" });

    // Participants exclude the account owner and are lowercased.
    const partInsert = fake.calls.inserts.find((i) => i.table === "meeting_participants");
    const emails = (partInsert?.payload as Array<{ email: string }>).map((p) => p.email).sort();
    expect(emails).toEqual(["boss@acme.com", "guest@client.com"]);
  });

  it("never sends a second bot for a calendar event that already has a meeting row", async () => {
    fake.seed("meetings", [{ id: "m-old", user_id: "u1", calendar_event_id: "evt-1" }]);

    const { scheduled } = await scheduleUpcomingMeetingBots("run-2");

    expect(scheduled).toBe(0);
    expect(createBot).not.toHaveBeenCalled();
    expect(fake.calls.inserts).toHaveLength(0);
  });

  it("skips excluded events and does not insert a meeting when Recall bot creation fails", async () => {
    // Explicit per-event exclusion keeps the bot out entirely.
    fake.seed("meeting_autojoin_exclusions", [
      { id: "x1", user_id: "u1", calendar_event_id: "evt-1" },
    ]);
    expect((await scheduleUpcomingMeetingBots("run-3")).scheduled).toBe(0);
    expect(createBot).not.toHaveBeenCalled();

    // Recall failure: the claim row is rolled back, so the next cron pass
    // retries the event instead of leaving a bot-less meeting behind.
    fake.reset();
    fake.seed("gmail_accounts", [ACCOUNT]);
    vi.mocked(createBot).mockRejectedValue(new Error("recall 502"));
    const { scheduled } = await scheduleUpcomingMeetingBots("run-4");
    expect(scheduled).toBe(0);
    expect(fake.calls.deletes.filter((d) => d.table === "meetings")).toHaveLength(1);
  });

  it("a concurrent run that loses the insert race creates no bot", async () => {
    // Two cron ticks can overlap; both see no existing meeting. The unique
    // index means only one insert survives, and the loser must stop before
    // spending money on a second bot for the same call.
    fake.onInsert("meetings", () => ({ message: "duplicate key value", code: "23505" }));
    const { scheduled } = await scheduleUpcomingMeetingBots("run-5");
    expect(scheduled).toBe(0);
    expect(createBot).not.toHaveBeenCalled();
    expect(fake.calls.inserts.filter((i) => i.table === "meeting_participants")).toHaveLength(0);
  });
});

// ── Calendar-backed helpers ───────────────────────────────────────────────
// Everything below drives the real Google Calendar reader with a stubbed
// `fetch`, so the per-calendar selection, the merge/dedupe and the listing's
// skip ladder are exercised end to end rather than mocked away.

type UpcomingEventStub = {
  id: string;
  summary?: string;
  hangoutLink?: string;
  colorId?: string;
  eventType?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    self?: boolean;
    responseStatus?: string;
  }>;
  organizer?: { email?: string; displayName?: string };
};
/** Events (or an HTTP failure) each calendar id should answer with. */
type CalendarStub = Record<string, UpcomingEventStub[] | { status: number }>;

/** Stub the Calendar events.list endpoint per calendar id, returning the
 *  array of URLs the SUT asked for so a test can assert what it queried. */
function stubCalendar(stub: CalendarStub): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      urls.push(input);
      const match = /\/calendars\/([^/]+)\/events/.exec(input);
      const calendarId = decodeURIComponent(match?.[1] ?? "");
      const answer = stub[calendarId];
      if (answer && !Array.isArray(answer)) {
        return new Response("calendar gone", { status: answer.status });
      }
      return new Response(JSON.stringify({ items: answer ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return urls;
}

const TIMED = { dateTime: "2026-09-01T12:10:00.000Z" };
const MEET_LINK = "https://meet.google.com/abc-defg-hij";

describe("loadEventFilterPrefs", () => {
  beforeEach(() => fake.reset());

  it("falls back to hiding the standard non-meeting types when nothing is stored", async () => {
    const stored = await loadEventFilterPrefs("u1");

    expect([...stored.hiddenEventTypes].sort()).toStrictEqual([...DEFAULT_HIDDEN_TYPES].sort());
    expect([...stored.colorSkip]).toStrictEqual([]);
  });

  it("uses the stored sets, including an explicitly empty hidden list", async () => {
    fake.seed("meeting_bot_settings", [
      { user_id: "u1", hidden_event_types: [], event_color_skip: ["5", "11"] },
    ]);

    const stored = await loadEventFilterPrefs("u1");

    // An empty array is a choice ("show everything"), not a missing value.
    expect([...stored.hiddenEventTypes]).toStrictEqual([]);
    expect([...stored.colorSkip].sort()).toStrictEqual(["11", "5"]);
  });

  it("treats null columns as unset and keeps the defaults", async () => {
    fake.seed("meeting_bot_settings", [
      { user_id: "u1", hidden_event_types: null, event_color_skip: null },
    ]);

    const stored = await loadEventFilterPrefs("u1");

    expect([...stored.hiddenEventTypes].sort()).toStrictEqual([...DEFAULT_HIDDEN_TYPES].sort());
    expect([...stored.colorSkip]).toStrictEqual([]);
  });

  it("never throws: a failing read logs and yields the defaults", async () => {
    fake.onSelect("meeting_bot_settings", () => {
      throw new Error("connection reset");
    });

    const stored = await loadEventFilterPrefs("u1");

    expect([...stored.hiddenEventTypes].sort()).toStrictEqual([...DEFAULT_HIDDEN_TYPES].sort());
    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      "meeting_event_filter_prefs_load_failed",
      { userId: "u1" },
      expect.any(Error),
    );
  });
});

describe("resolveSelectedCalendarIds", () => {
  beforeEach(() => fake.reset());

  it("falls back to the primary calendar when the account has never chosen", async () => {
    expect(await resolveSelectedCalendarIds("acct-1")).toStrictEqual(["primary"]);
  });

  it("returns only the enabled calendars, scoped to the account", async () => {
    fake.seed("meeting_calendar_selections", [
      {
        gmail_account_id: "acct-1",
        user_id: "u1",
        calendar_id: "work@group.calendar",
        enabled: true,
      },
      {
        gmail_account_id: "acct-1",
        user_id: "u1",
        calendar_id: "muted@group.calendar",
        enabled: false,
      },
      {
        gmail_account_id: "acct-2",
        user_id: "u1",
        calendar_id: "other@group.calendar",
        enabled: true,
      },
    ]);

    expect(await resolveSelectedCalendarIds("acct-1")).toStrictEqual(["work@group.calendar"]);
  });

  it("records nothing when the account disabled every calendar it has", async () => {
    fake.seed("meeting_calendar_selections", [
      { gmail_account_id: "acct-1", user_id: "u1", calendar_id: "primary", enabled: false },
    ]);

    expect(await resolveSelectedCalendarIds("acct-1")).toStrictEqual([]);
  });
});

describe("multi-calendar event fetching", () => {
  beforeEach(() => {
    fake.reset();
    vi.mocked(getAccessToken).mockResolvedValue("google-token");
  });

  it("merges the selected calendars and keeps one entry per event id", async () => {
    fake.seed("meeting_calendar_selections", [
      { gmail_account_id: "acct-1", user_id: "u1", calendar_id: "cal-a", enabled: true },
      { gmail_account_id: "acct-1", user_id: "u1", calendar_id: "cal-b", enabled: true },
    ]);
    stubCalendar({
      // The same invitation appears on both calendars; the later one wins.
      "cal-a": [{ id: "shared", summary: "From A", start: TIMED, hangoutLink: MEET_LINK }],
      "cal-b": [
        { id: "shared", summary: "From B", start: TIMED, hangoutLink: MEET_LINK },
        { id: "only-b", summary: "B only", start: TIMED, hangoutLink: MEET_LINK },
      ],
    });

    const events = await listUpcomingCalendarEventsForAccount("acct-1", "u1");

    expect(events.map((e) => [e.id, e.title])).toStrictEqual([
      ["shared", "From B"],
      ["only-b", "B only"],
    ]);
  });

  it("keeps the other calendars when one of them fails", async () => {
    fake.seed("meeting_calendar_selections", [
      { gmail_account_id: "acct-1", user_id: "u1", calendar_id: "cal-gone", enabled: true },
      { gmail_account_id: "acct-1", user_id: "u1", calendar_id: "cal-ok", enabled: true },
    ]);
    stubCalendar({
      "cal-gone": { status: 404 },
      "cal-ok": [{ id: "evt-ok", summary: "Still here", start: TIMED, hangoutLink: MEET_LINK }],
    });

    const events = await listUpcomingCalendarEventsForAccount("acct-1", "u1");

    expect(events.map((e) => e.id)).toStrictEqual(["evt-ok"]);
    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      "meeting_calendar_fetch_failed",
      { accountId: "acct-1", calendarId: "cal-gone" },
      expect.any(Error),
    );
  });

  it("asks Google for nothing when the account disabled every calendar", async () => {
    fake.seed("meeting_calendar_selections", [
      { gmail_account_id: "acct-1", user_id: "u1", calendar_id: "primary", enabled: false },
    ]);
    const urls = stubCalendar({});

    expect(await listUpcomingCalendarEventsForAccount("acct-1", "u1")).toStrictEqual([]);
    expect(urls).toStrictEqual([]);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("drops all-day and hidden-type entries before annotating anything", async () => {
    stubCalendar({
      primary: [
        { id: "all-day", start: { date: "2026-09-02" }, hangoutLink: MEET_LINK },
        { id: "ooo", eventType: "outOfOffice", start: TIMED, hangoutLink: MEET_LINK },
        { id: "real", start: TIMED, hangoutLink: MEET_LINK },
      ],
    });

    const events = await listUpcomingCalendarEventsForAccount("acct-1", "u1");

    expect(events.map((e) => e.id)).toStrictEqual(["real"]);
  });
});

describe("listCalendarEventsWindow skip ladder", () => {
  const EVENTS: UpcomingEventStub[] = [
    { id: "e-no-link", summary: "No link", start: TIMED, end: TIMED },
    {
      id: "e-declined",
      summary: "Declined",
      start: TIMED,
      hangoutLink: MEET_LINK,
      attendees: [{ email: "me@acme.com", self: true, responseStatus: "declined" }],
    },
    { id: "e-off", summary: "Turned off", start: TIMED, hangoutLink: MEET_LINK },
    { id: "e-in-person", summary: "In person", start: TIMED, hangoutLink: MEET_LINK },
    {
      id: "e-blocked",
      summary: "Blocked",
      start: TIMED,
      hangoutLink: MEET_LINK,
      attendees: [{ email: "legal@lawfirm.com" }],
    },
    { id: "e-ok", summary: "Will record", start: TIMED, end: TIMED, hangoutLink: MEET_LINK },
  ];

  beforeEach(() => {
    fake.reset();
    vi.mocked(getAccessToken).mockResolvedValue("google-token");
    fake.seed("gmail_accounts", [
      { id: "acct-1", user_id: "u1", auto_record_meetings: true, record_declined_meetings: false },
    ]);
    fake.seed("meeting_autojoin_exclusions", [
      {
        id: "x1",
        user_id: "u1",
        gmail_account_id: "acct-1",
        calendar_event_id: "e-off",
        mode: "off",
      },
      {
        id: "x2",
        user_id: "u1",
        gmail_account_id: "acct-1",
        calendar_event_id: "e-in-person",
        mode: "in_person",
      },
    ]);
    fake.seed("meeting_record_blocklist", [{ user_id: "u1", value: "lawfirm.com" }]);
    stubCalendar({ primary: EVENTS });
  });

  it("gives each unrecordable event its own reason, and records the rest", async () => {
    const rows = await listCalendarEventsWindow("acct-1", "u1", 1, 7);

    expect(rows.map((r) => [r.id, r.willRecord, r.skipReason])).toStrictEqual([
      ["e-no-link", false, "no_link"],
      ["e-declined", false, "declined"],
      ["e-off", false, "off"],
      ["e-in-person", false, "in_person"],
      ["e-blocked", false, "blocked"],
      ["e-ok", true, null],
    ]);
    expect(rows.find((r) => r.id === "e-blocked")?.blockedBy).toBe("lawfirm.com");
  });

  it("reports auto_record_off for every linked event when the account has auto-record off", async () => {
    fake.seed("gmail_accounts", [
      { id: "acct-1", user_id: "u1", auto_record_meetings: false, record_declined_meetings: false },
    ]);

    const rows = await listCalendarEventsWindow("acct-1", "u1", 1, 7);

    expect(rows.filter((r) => r.willRecord)).toStrictEqual([]);
    expect(rows.filter((r) => r.id !== "e-no-link").map((r) => r.skipReason)).toStrictEqual([
      "auto_record_off",
      "auto_record_off",
      "auto_record_off",
      "auto_record_off",
      "auto_record_off",
    ]);
  });

  it("records a declined meeting when the account opted in", async () => {
    fake.seed("gmail_accounts", [
      { id: "acct-1", user_id: "u1", auto_record_meetings: true, record_declined_meetings: true },
    ]);

    const rows = await listCalendarEventsWindow("acct-1", "u1", 1, 7);

    expect(rows.find((r) => r.id === "e-declined")).toMatchObject({
      declined: true,
      willRecord: true,
      skipReason: null,
    });
  });

  // CHARACTERIZATION(calendar-window-hides-colour-skipped-events): the colour
  // filter runs before annotation, so an event tagged a switched-off colour is
  // dropped from the listing entirely and the "color" skip reason the UI has
  // copy for can never be produced — flip when fixed.
  it("removes a colour-skipped event from the window instead of labelling it", async () => {
    fake.seed("meeting_bot_settings", [
      { user_id: "u1", hidden_event_types: [], event_color_skip: ["5"] },
    ]);
    stubCalendar({
      primary: [
        {
          id: "e-colour",
          summary: "Muted colour",
          start: TIMED,
          hangoutLink: MEET_LINK,
          colorId: "5",
        },
        { id: "e-ok", summary: "Will record", start: TIMED, hangoutLink: MEET_LINK },
      ],
    });

    const rows = await listCalendarEventsWindow("acct-1", "u1", 1, 7);

    expect(rows.map((r) => r.id)).toStrictEqual(["e-ok"]);
    expect(rows.map((r) => r.skipReason)).not.toContain("color");
  });

  it("carries the linked meeting row onto its event", async () => {
    fake.seed("meetings", [
      {
        id: "m-1",
        user_id: "u1",
        calendar_event_id: "e-ok",
        status: "done",
        recording_url: "https://recall.test/rec.mp4",
        recall_bot_id: "bot-1",
        meeting_url: MEET_LINK,
      },
    ]);

    const rows = await listCalendarEventsWindow("acct-1", "u1", 1, 7);

    expect(rows.find((r) => r.id === "e-ok")).toMatchObject({
      scheduled: true,
      meetingId: "m-1",
      meetingStatus: "done",
      hasRecording: true,
      canResendBot: false,
      end: TIMED.dateTime,
    });
  });

  it("returns an empty list without reading meetings when the window has no events", async () => {
    stubCalendar({ primary: [] });

    expect(await listCalendarEventsWindow("acct-1", "u1", 1, 7)).toStrictEqual([]);
    expect(fake.calls.selects.some((s) => s.table === "meetings")).toBe(false);
  });
});

describe("upsertEventExclusion", () => {
  // The fake stands in for the caller's RLS-scoped client; the cast is
  // structural only — the function uses a single upsert builder.
  const rlsClient = fake.client as unknown as SupabaseClient<Database>;
  const entry = { userId: "u1", accountId: "acct-1", calendarEventId: "evt-1" };

  beforeEach(() => fake.reset());

  it("writes the mode with the natural-key conflict target", async () => {
    expect(await upsertEventExclusion(rlsClient, entry, "in_person")).toBeNull();

    expect(fake.calls.upserts).toStrictEqual([
      {
        table: "meeting_autojoin_exclusions",
        payload: {
          user_id: "u1",
          gmail_account_id: "acct-1",
          calendar_event_id: "evt-1",
          mode: "in_person",
        },
        options: { onConflict: "user_id,calendar_event_id" },
        filters: [],
      },
    ]);
  });

  it.each([
    ["PGRST204", "Could not find the 'mode' column of 'meeting_autojoin_exclusions'"],
    ["42703", 'column "mode" does not exist'],
    // Neither code, but the message names the column.
    ["", 'column "mode" does not exist'],
  ])("retries without mode when the migration has not landed (%s)", async (code, message) => {
    fake.onUpsert("meeting_autojoin_exclusions", (payload) =>
      payload && typeof payload === "object" && "mode" in payload
        ? { message, ...(code ? { code } : {}) }
        : null,
    );

    expect(await upsertEventExclusion(rlsClient, entry, "in_person")).toBeNull();

    expect(fake.calls.upserts).toHaveLength(2);
    // The retry still keeps the bot out; only the in-person intent is lost.
    expect(fake.calls.upserts[1]?.payload).toStrictEqual({
      user_id: "u1",
      gmail_account_id: "acct-1",
      calendar_event_id: "evt-1",
    });
  });

  it("surfaces the retry's own failure", async () => {
    fake.onUpsert("meeting_autojoin_exclusions", (payload) =>
      payload && typeof payload === "object" && "mode" in payload
        ? { message: 'column "mode" does not exist', code: "42703" }
        : { message: "new row violates row-level security policy" },
    );

    expect(await upsertEventExclusion(rlsClient, entry, "off")).toBe(
      "new row violates row-level security policy",
    );
  });

  it("does not retry an unrelated failure", async () => {
    fake.onUpsert("meeting_autojoin_exclusions", () => ({
      message: "new row violates row-level security policy",
      code: "42501",
    }));

    expect(await upsertEventExclusion(rlsClient, entry, "off")).toBe(
      "new row violates row-level security policy",
    );
    expect(fake.calls.upserts).toHaveLength(1);
  });
});

describe("findBlockedAttendeeForMeetingUrl", () => {
  beforeEach(() => {
    fake.reset();
    vi.mocked(getAccessToken).mockResolvedValue("google-token");
    fake.seed("gmail_accounts", [
      { id: "acct-1", user_id: "u1", calendar_access: true },
      { id: "acct-2", user_id: "u1", calendar_access: true },
    ]);
  });

  it("skips the calendar entirely when the user has no blocklist", async () => {
    const urls = stubCalendar({});

    expect(await findBlockedAttendeeForMeetingUrl("u1", MEET_LINK)).toBeNull();
    expect(urls).toStrictEqual([]);
  });

  it("matches the event ignoring case, query, hash and a trailing slash", async () => {
    fake.seed("meeting_record_blocklist", [{ user_id: "u1", value: "legal@lawfirm.com" }]);
    stubCalendar({
      primary: [
        {
          id: "evt-1",
          start: TIMED,
          hangoutLink: "https://MEET.google.com/abc-defg-hij/?authuser=1#chat",
          attendees: [{ email: "Legal@LawFirm.com" }],
        },
      ],
    });

    expect(
      await findBlockedAttendeeForMeetingUrl("u1", " https://meet.google.com/abc-defg-hij "),
    ).toBe("legal@lawfirm.com");
  });

  it("blocks on the organizer's domain as well as the attendees", async () => {
    fake.seed("meeting_record_blocklist", [{ user_id: "u1", value: "lawfirm.com" }]);
    stubCalendar({
      primary: [
        {
          id: "evt-1",
          start: TIMED,
          hangoutLink: MEET_LINK,
          attendees: [{ email: "me@acme.com" }],
          organizer: { email: "partner@lawfirm.com" },
        },
      ],
    });

    expect(await findBlockedAttendeeForMeetingUrl("u1", MEET_LINK)).toBe("lawfirm.com");
  });

  it("returns null when no calendar event uses that link", async () => {
    fake.seed("meeting_record_blocklist", [{ user_id: "u1", value: "lawfirm.com" }]);
    stubCalendar({
      primary: [
        {
          id: "evt-1",
          start: TIMED,
          hangoutLink: "https://meet.google.com/zzz-zzzz-zzz",
          attendees: [{ email: "partner@lawfirm.com" }],
        },
      ],
    });

    expect(await findBlockedAttendeeForMeetingUrl("u1", MEET_LINK)).toBeNull();
  });

  it("keeps scanning the remaining accounts when one account's calendar fails", async () => {
    fake.seed("meeting_record_blocklist", [{ user_id: "u1", value: "lawfirm.com" }]);
    fake.seed("meeting_calendar_selections", [
      { gmail_account_id: "acct-1", user_id: "u1", calendar_id: "broken", enabled: true },
      { gmail_account_id: "acct-2", user_id: "u1", calendar_id: "good", enabled: true },
    ]);
    stubCalendar({
      broken: { status: 500 },
      good: [
        {
          id: "evt-1",
          start: TIMED,
          hangoutLink: MEET_LINK,
          attendees: [{ email: "partner@lawfirm.com" }],
        },
      ],
    });

    expect(await findBlockedAttendeeForMeetingUrl("u1", MEET_LINK)).toBe("lawfirm.com");
    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      "meeting_calendar_fetch_failed",
      { accountId: "acct-1", calendarId: "broken" },
      expect.any(Error),
    );
  });

  it("keeps scanning when an account's Google grant no longer yields a token", async () => {
    fake.seed("meeting_record_blocklist", [{ user_id: "u1", value: "lawfirm.com" }]);
    vi.mocked(getAccessToken).mockImplementation(async (accountId: string) => {
      if (accountId === "acct-1") throw new Error("invalid_grant");
      return "google-token";
    });
    stubCalendar({
      primary: [
        {
          id: "evt-1",
          start: TIMED,
          hangoutLink: MEET_LINK,
          attendees: [{ email: "partner@lawfirm.com" }],
        },
      ],
    });

    expect(await findBlockedAttendeeForMeetingUrl("u1", MEET_LINK)).toBe("lawfirm.com");
    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      "meeting_blocklist_calendar_failed",
      { userId: "u1", accountId: "acct-1" },
      expect.any(Error),
    );
  });
});

describe("listGoogleCalendars", () => {
  beforeEach(() => {
    fake.reset();
    vi.mocked(getAccessToken).mockResolvedValue("google-token");
  });

  it("prefers the user's override name and drops entries with no id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              items: [
                { id: "primary", summary: "me@acme.com", primary: true },
                { id: "team", summary: "Team", summaryOverride: "My team" },
                { id: "nameless" },
                { summary: "orphan" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    expect(await listGoogleCalendars("acct-1")).toStrictEqual([
      { id: "primary", summary: "me@acme.com", primary: true },
      { id: "team", summary: "My team", primary: false },
      { id: "nameless", summary: null, primary: false },
    ]);
  });

  it("throws with the status when Google refuses the list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no scope", { status: 403 })),
    );

    await expect(listGoogleCalendars("acct-1")).rejects.toThrow("Calendar list 403: no scope");
  });
});
