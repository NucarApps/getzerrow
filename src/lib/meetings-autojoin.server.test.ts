// Tests for the pure event-filter / meeting-URL / resend predicates in
// src/lib/meetings-autojoin.server.ts. These decide what the notetaker records
// and whether a bot may be re-sent, so their edge cases matter. The module's
// heavy server dependencies are stubbed since only the pure functions are used.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
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
  type EventFilterPrefs,
} from "./meetings-autojoin.server";

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
