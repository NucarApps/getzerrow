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
  type EventFilterPrefs,
} from "./meetings-autojoin.server";
import { createBot, detectPlatform, type RecallBot } from "./recall.server";
import { getAccessToken } from "./google-oauth.server";
import { loadBotConfig } from "./meetings.server";

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
