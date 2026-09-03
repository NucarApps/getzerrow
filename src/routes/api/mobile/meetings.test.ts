// Authorised-path contract for POST /api/mobile/meetings.
//
// auth-sweep.test.ts proves the route refuses an unauthenticated caller.
// This suite covers the other side: every `kind` the route dispatches, the
// exact JSON the iOS app receives back, what reaches the database, and the
// refusal each action gives for an id the caller does not own. The app ships
// separately from the server, so the response shapes below are a contract:
// changing one breaks a build of the app that is already on phones.
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import {
  MOBILE_USER,
  OTHER_USER,
  jsonBody,
  mobileRequest,
  mockMobileAuth,
  rlsScoped,
  serverHandler,
} from "@/lib/__fixtures__/mobile-route-harness";
import type { CalendarWindowEvent, UpcomingCalendarEvent } from "@/lib/meetings-autojoin.server";
import * as meetingsRoute from "./meetings";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));
vi.mock("@/lib/mobile-auth.server", () => mockMobileAuth(() => fake));

const autojoin = vi.hoisted(() => ({
  listUpcomingCalendarEventsForAccount:
    vi.fn<typeof import("@/lib/meetings-autojoin.server").listUpcomingCalendarEventsForAccount>(),
  listCalendarEventsWindow:
    vi.fn<typeof import("@/lib/meetings-autojoin.server").listCalendarEventsWindow>(),
  upsertEventExclusion:
    vi.fn<typeof import("@/lib/meetings-autojoin.server").upsertEventExclusion>(),
}));
vi.mock("@/lib/meetings-autojoin.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meetings-autojoin.server")>()),
  ...autojoin,
}));

const finalizeInPersonMeeting = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/meetings.server").finalizeInPersonMeeting>(),
);
vi.mock("@/lib/meetings.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meetings.server")>()),
  finalizeInPersonMeeting,
}));

const logError = vi.hoisted(() => vi.fn<typeof import("@/lib/log.server").logError>());
vi.mock("@/lib/log.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/log.server")>()),
  logError,
}));

const POST = serverHandler(meetingsRoute, "POST");

const ACCOUNT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ACCOUNT_B = "aaaaaaaa-0000-4000-8000-000000000002";
const FOREIGN_ACCOUNT = "aaaaaaaa-0000-4000-8000-0000000000ff";
const MEETING_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const FOREIGN_MEETING = "bbbbbbbb-0000-4000-8000-0000000000ff";

const NOW = "2026-09-03T12:00:00.000Z";

function post(body: unknown) {
  return POST(mobileRequest("/api/mobile/meetings", { body }));
}

function upcomingEvent(over: Partial<UpcomingCalendarEvent> = {}): UpcomingCalendarEvent {
  return {
    id: "evt-1",
    title: "Standup",
    start: "2026-09-04T09:00:00.000Z",
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
    ...over,
  };
}

function windowEvent(over: Partial<CalendarWindowEvent> = {}): CalendarWindowEvent {
  return {
    ...upcomingEvent(),
    end: "2026-09-04T09:30:00.000Z",
    willRecord: true,
    skipReason: null,
    ...over,
  };
}

/** Both calendar-enabled inboxes the suite's user owns, plus one belonging to
 * another tenant that RLS must hide. */
function seedAccounts() {
  fake.seed("gmail_accounts", [
    { id: ACCOUNT_A, user_id: MOBILE_USER, email_address: "a@work.test", calendar_access: true },
    { id: ACCOUNT_B, user_id: MOBILE_USER, email_address: null, calendar_access: true },
    {
      id: FOREIGN_ACCOUNT,
      user_id: OTHER_USER,
      email_address: "victim@other.test",
      calendar_access: true,
    },
  ]);
  rlsScoped(fake, "gmail_accounts", MOBILE_USER);
}

beforeEach(() => {
  fake.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  autojoin.listUpcomingCalendarEventsForAccount.mockResolvedValue([]);
  autojoin.listCalendarEventsWindow.mockResolvedValue([]);
  autojoin.upsertEventExclusion.mockResolvedValue(null);
  finalizeInPersonMeeting.mockResolvedValue("completed");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/mobile/meetings — request validation", () => {
  it("refuses a body that is not JSON with 400 and touches no table", async () => {
    const res = await POST(mobileRequest("/api/mobile/meetings", { rawBody: "{not json" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid request body");
    expect(fake.calls.selects).toEqual([]);
    expect(writeCount(fake)).toBe(0);
  });

  it("refuses an unknown kind", async () => {
    const res = await post({ kind: "drop_tables" });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid request body");
  });

  it("refuses set_mode with a mode outside bot/in_person/off", async () => {
    const res = await post({
      kind: "set_mode",
      account_id: ACCOUNT_A,
      calendar_event_id: "evt-1",
      mode: "transcribe",
    });
    expect(res.status).toBe(400);
    expect(writeCount(fake)).toBe(0);
  });

  it("refuses set_exclusion with a non-uuid account_id", async () => {
    const res = await post({
      kind: "set_exclusion",
      account_id: "not-a-uuid",
      calendar_event_id: "evt-1",
      excluded: true,
    });
    expect(res.status).toBe(400);
    expect(fake.calls.selects).toEqual([]);
  });
});

describe("kind:upcoming", () => {
  it("reports calendar_access:false and no events when no inbox has calendar access", async () => {
    fake.seed("gmail_accounts", [
      { id: ACCOUNT_A, user_id: MOBILE_USER, email_address: "a@work.test", calendar_access: false },
    ]);
    rlsScoped(fake, "gmail_accounts", MOBILE_USER);

    const res = await post({ kind: "upcoming" });
    expect(await jsonBody(res, 200)).toStrictEqual({
      ok: true,
      calendar_access: false,
      events: [],
    });
    expect(autojoin.listUpcomingCalendarEventsForAccount).not.toHaveBeenCalled();
  });

  it("merges both inboxes' events, sorted by start, in the shape the app reads", async () => {
    seedAccounts();
    autojoin.listUpcomingCalendarEventsForAccount.mockImplementation(async (accountId) =>
      accountId === ACCOUNT_A
        ? [
            upcomingEvent({
              id: "late",
              title: "Retro",
              start: "2026-09-05T09:00:00.000Z",
              recordMode: "in_person",
              blocked: true,
              blockedBy: "legal@other.test",
            }),
          ]
        : [upcomingEvent({ id: "early", start: "2026-09-04T09:00:00.000Z", scheduled: true })],
    );

    const body = await jsonBody(await post({ kind: "upcoming" }), 200);
    expect(body).toStrictEqual({
      ok: true,
      calendar_access: true,
      events: [
        {
          id: "early",
          title: "Standup",
          start: "2026-09-04T09:00:00.000Z",
          has_meeting_link: true,
          scheduled: true,
          excluded: false,
          record_mode: "bot",
          blocked: false,
          blocked_by: null,
          account_id: ACCOUNT_B,
          account_email: null,
        },
        {
          id: "late",
          title: "Retro",
          start: "2026-09-05T09:00:00.000Z",
          has_meeting_link: true,
          scheduled: false,
          excluded: false,
          record_mode: "in_person",
          blocked: true,
          blocked_by: "legal@other.test",
          account_id: ACCOUNT_A,
          account_email: "a@work.test",
        },
      ],
    });
  });

  it("never lists another tenant's calendar-enabled inbox", async () => {
    seedAccounts();
    await post({ kind: "upcoming" });
    const listedAccounts = autojoin.listUpcomingCalendarEventsForAccount.mock.calls.map(
      ([accountId]) => accountId,
    );
    expect(listedAccounts).toStrictEqual([ACCOUNT_A, ACCOUNT_B]);
  });

  it("keeps the working inbox's events when one inbox throws, and logs the failure", async () => {
    seedAccounts();
    autojoin.listUpcomingCalendarEventsForAccount.mockImplementation(async (accountId) => {
      if (accountId === ACCOUNT_A) throw new Error("token revoked");
      return [upcomingEvent({ id: "ok" })];
    });

    const body = await jsonBody<{ events: Array<{ id: string }> }>(
      await post({ kind: "upcoming" }),
      200,
    );
    expect(body.events.map((e) => e.id)).toStrictEqual(["ok"]);
    expect(logError).toHaveBeenCalledWith(
      "mobile_meetings_upcoming_failed",
      { accountId: ACCOUNT_A, userId: MOBILE_USER },
      expect.any(Error),
    );
  });
});

describe("kind:calendar", () => {
  it("asks for the 7-days-back / 14-days-ahead window per inbox", async () => {
    seedAccounts();
    await post({ kind: "calendar" });
    expect(autojoin.listCalendarEventsWindow.mock.calls).toStrictEqual([
      [ACCOUNT_A, MOBILE_USER, 7, 14],
      [ACCOUNT_B, MOBILE_USER, 7, 14],
    ]);
  });

  it("returns the annotated window row the app renders", async () => {
    fake.seed("gmail_accounts", [
      { id: ACCOUNT_A, user_id: MOBILE_USER, email_address: "a@work.test", calendar_access: true },
    ]);
    rlsScoped(fake, "gmail_accounts", MOBILE_USER);
    autojoin.listCalendarEventsWindow.mockResolvedValue([
      windowEvent({
        id: "evt-9",
        declined: true,
        willRecord: false,
        skipReason: "declined",
        meetingId: MEETING_ID,
        meetingStatus: "completed",
        hasRecording: true,
      }),
    ]);

    expect(await jsonBody(await post({ kind: "calendar" }), 200)).toStrictEqual({
      ok: true,
      calendar_access: true,
      events: [
        {
          id: "evt-9",
          title: "Standup",
          start: "2026-09-04T09:00:00.000Z",
          end: "2026-09-04T09:30:00.000Z",
          has_meeting_link: true,
          scheduled: false,
          excluded: false,
          record_mode: "bot",
          blocked: false,
          blocked_by: null,
          declined: true,
          will_record: false,
          skip_reason: "declined",
          meeting_id: MEETING_ID,
          meeting_status: "completed",
          has_recording: true,
          account_id: ACCOUNT_A,
          account_email: "a@work.test",
        },
      ],
    });
  });

  it("reports calendar_access:false with no calendar-enabled inbox", async () => {
    fake.seed("gmail_accounts", []);
    expect(await jsonBody(await post({ kind: "calendar" }), 200)).toStrictEqual({
      ok: true,
      calendar_access: false,
      events: [],
    });
  });

  it("survives one inbox failing", async () => {
    seedAccounts();
    autojoin.listCalendarEventsWindow.mockImplementation(async (accountId) => {
      if (accountId === ACCOUNT_A) throw new Error("calendar down");
      return [windowEvent({ id: "kept" })];
    });
    const body = await jsonBody<{ events: Array<{ id: string }> }>(
      await post({ kind: "calendar" }),
      200,
    );
    expect(body.events.map((e) => e.id)).toStrictEqual(["kept"]);
    expect(logError).toHaveBeenCalledWith(
      "mobile_meetings_calendar_failed",
      { accountId: ACCOUNT_A, userId: MOBILE_USER },
      expect.any(Error),
    );
  });
});

describe("kind:set_exclusion", () => {
  beforeEach(seedAccounts);

  it("excluding an event upserts the exclusion in 'off' mode", async () => {
    const res = await post({
      kind: "set_exclusion",
      account_id: ACCOUNT_A,
      calendar_event_id: "evt-1",
      excluded: true,
    });
    expect(await jsonBody(res, 200)).toStrictEqual({ ok: true });
    expect(autojoin.upsertEventExclusion).toHaveBeenCalledWith(
      fake.client,
      { userId: MOBILE_USER, accountId: ACCOUNT_A, calendarEventId: "evt-1" },
      "off",
    );
  });

  it("un-excluding deletes the row for this user and event", async () => {
    const res = await post({
      kind: "set_exclusion",
      account_id: ACCOUNT_A,
      calendar_event_id: "evt-1",
      excluded: false,
    });
    expect(await jsonBody(res, 200)).toStrictEqual({ ok: true });
    expect(autojoin.upsertEventExclusion).not.toHaveBeenCalled();
    const del = fake.calls.deletes;
    expect(del).toHaveLength(1);
    expect(del[0]?.table).toBe("meeting_autojoin_exclusions");
    expect(del[0]?.filters).toStrictEqual([
      { op: "eq", col: "user_id", value: MOBILE_USER, extra: undefined },
      { op: "eq", col: "calendar_event_id", value: "evt-1", extra: undefined },
    ]);
  });

  it("refuses an account belonging to another tenant with 404 and writes nothing", async () => {
    const res = await post({
      kind: "set_exclusion",
      account_id: FOREIGN_ACCOUNT,
      calendar_event_id: "evt-1",
      excluded: true,
    });
    expect(await jsonBody(res, 404)).toStrictEqual({ ok: false, error: "Account not found" });
    expect(autojoin.upsertEventExclusion).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("surfaces an upsert failure as 400 with the message", async () => {
    autojoin.upsertEventExclusion.mockResolvedValue("column mode does not exist");
    const res = await post({
      kind: "set_exclusion",
      account_id: ACCOUNT_A,
      calendar_event_id: "evt-1",
      excluded: true,
    });
    expect(await jsonBody(res, 400)).toStrictEqual({
      ok: false,
      error: "column mode does not exist",
    });
  });

  it("surfaces a delete failure as 400 with the message", async () => {
    fake.onDelete("meeting_autojoin_exclusions", () => ({ message: "delete denied" }));
    const res = await post({
      kind: "set_exclusion",
      account_id: ACCOUNT_A,
      calendar_event_id: "evt-1",
      excluded: false,
    });
    expect(await jsonBody(res, 400)).toStrictEqual({ ok: false, error: "delete denied" });
  });
});

describe("kind:set_mode", () => {
  beforeEach(seedAccounts);

  it("'bot' removes the exclusion row and echoes the mode", async () => {
    const res = await post({
      kind: "set_mode",
      account_id: ACCOUNT_A,
      calendar_event_id: "evt-2",
      mode: "bot",
    });
    expect(await jsonBody(res, 200)).toStrictEqual({ ok: true, mode: "bot" });
    expect(fake.calls.deletes.map((d) => d.table)).toStrictEqual(["meeting_autojoin_exclusions"]);
    expect(autojoin.upsertEventExclusion).not.toHaveBeenCalled();
  });

  it("'in_person' upserts the exclusion carrying the mode", async () => {
    const res = await post({
      kind: "set_mode",
      account_id: ACCOUNT_A,
      calendar_event_id: "evt-2",
      mode: "in_person",
    });
    expect(await jsonBody(res, 200)).toStrictEqual({ ok: true, mode: "in_person" });
    expect(autojoin.upsertEventExclusion).toHaveBeenCalledWith(
      fake.client,
      { userId: MOBILE_USER, accountId: ACCOUNT_A, calendarEventId: "evt-2" },
      "in_person",
    );
  });

  it("'off' upserts the exclusion in 'off' mode", async () => {
    const res = await post({
      kind: "set_mode",
      account_id: ACCOUNT_A,
      calendar_event_id: "evt-2",
      mode: "off",
    });
    expect(await jsonBody(res, 200)).toStrictEqual({ ok: true, mode: "off" });
    expect(autojoin.upsertEventExclusion).toHaveBeenCalledWith(
      fake.client,
      expect.anything(),
      "off",
    );
  });

  it("refuses another tenant's account with 404 and writes nothing", async () => {
    const res = await post({
      kind: "set_mode",
      account_id: FOREIGN_ACCOUNT,
      calendar_event_id: "evt-2",
      mode: "in_person",
    });
    expect(await jsonBody(res, 404)).toStrictEqual({ ok: false, error: "Account not found" });
    expect(writeCount(fake)).toBe(0);
    expect(autojoin.upsertEventExclusion).not.toHaveBeenCalled();
  });

  it("surfaces a failed 'bot' delete as 400", async () => {
    fake.onDelete("meeting_autojoin_exclusions", () => ({ message: "row locked" }));
    const res = await post({
      kind: "set_mode",
      account_id: ACCOUNT_A,
      calendar_event_id: "evt-2",
      mode: "bot",
    });
    expect(await jsonBody(res, 400)).toStrictEqual({ ok: false, error: "row locked" });
  });
});

describe("kind:in_person_create", () => {
  beforeEach(() => {
    seedAccounts();
    // The meetings id is generated by Postgres; the fake injects it the way a
    // `.select("id").single()` on the real insert would return it.
    fake.onInsert("meetings", () => ({ data: { id: MEETING_ID } }));
  });

  it("inserts a processing in-person meeting and hands back the upload path", async () => {
    const res = await post({ kind: "in_person_create" });
    expect(await jsonBody(res, 200)).toStrictEqual({
      ok: true,
      id: MEETING_ID,
      audio_path: `${MOBILE_USER}/${MEETING_ID}.m4a`,
    });
    expect(fake.calls.inserts).toHaveLength(1);
    expect(fake.calls.inserts[0]?.payload).toStrictEqual({
      user_id: MOBILE_USER,
      meeting_url: null,
      platform: "in_person",
      source: "in_person",
      status: "processing",
      title: "In-person meeting",
      started_at: NOW,
      gmail_account_id: null,
      calendar_event_id: null,
      scheduled_start: null,
    });
  });

  it("carries the title, calendar link and scheduled start, and honours the ext", async () => {
    const res = await post({
      kind: "in_person_create",
      title: "  Board sync  ",
      ext: "wav",
      calendar_event_id: "evt-7",
      account_id: ACCOUNT_A,
      scheduled_start: "2026-09-03T15:30:00Z",
    });
    const body = await jsonBody<{ audio_path: string }>(res, 200);
    expect(body.audio_path).toBe(`${MOBILE_USER}/${MEETING_ID}.wav`);
    expect(fake.calls.inserts[0]?.payload).toMatchObject({
      title: "Board sync",
      gmail_account_id: ACCOUNT_A,
      calendar_event_id: "evt-7",
      scheduled_start: "2026-09-03T15:30:00.000Z",
    });
  });

  it("falls back to the default title when the given one is blank", async () => {
    await post({ kind: "in_person_create", title: "   " });
    expect(fake.calls.inserts[0]?.payload).toMatchObject({ title: "In-person meeting" });
  });

  it("refuses a foreign account_id with 404 and inserts nothing", async () => {
    const res = await post({ kind: "in_person_create", account_id: FOREIGN_ACCOUNT });
    expect(await jsonBody(res, 404)).toStrictEqual({ ok: false, error: "Account not found" });
    expect(writeCount(fake)).toBe(0);
  });

  it("refuses an unsupported audio extension", async () => {
    const res = await post({ kind: "in_person_create", ext: "flac" });
    expect(res.status).toBe(400);
    expect(writeCount(fake)).toBe(0);
  });

  it("refuses an unparseable scheduled_start", async () => {
    const res = await post({ kind: "in_person_create", scheduled_start: "next tuesday-ish" });
    expect(res.status).toBe(400);
    expect(writeCount(fake)).toBe(0);
  });

  it("surfaces an insert failure as 400 with the message", async () => {
    fake.onInsert("meetings", () => ({ message: "meetings insert denied" }));
    const res = await post({ kind: "in_person_create" });
    expect(await jsonBody(res, 400)).toStrictEqual({
      ok: false,
      error: "meetings insert denied",
    });
  });
});

describe("kind:in_person_transcribe", () => {
  beforeEach(() => {
    fake.seed("meetings", [
      { id: MEETING_ID, user_id: MOBILE_USER, source: "in_person" },
      { id: FOREIGN_MEETING, user_id: OTHER_USER, source: "in_person" },
    ]);
    rlsScoped(fake, "meetings", MOBILE_USER);
  });

  it("stamps the audio path, finalizes, and returns the resulting status", async () => {
    finalizeInPersonMeeting.mockResolvedValue("completed");
    const res = await post({
      kind: "in_person_transcribe",
      id: MEETING_ID,
      audio_path: `${MOBILE_USER}/${MEETING_ID}.m4a`,
    });
    expect(await jsonBody(res, 200)).toStrictEqual({ ok: true, status: "completed" });
    expect(fake.calls.updates).toHaveLength(1);
    expect(fake.calls.updates[0]?.table).toBe("meetings");
    expect(fake.calls.updates[0]?.payload).toStrictEqual({
      audio_storage_path: `${MOBILE_USER}/${MEETING_ID}.m4a`,
      status: "processing",
    });
    expect(finalizeInPersonMeeting).toHaveBeenCalledWith(MEETING_ID);
  });

  it("refuses another tenant's meeting id with 404 and writes nothing", async () => {
    const res = await post({
      kind: "in_person_transcribe",
      id: FOREIGN_MEETING,
      audio_path: `${MOBILE_USER}/${FOREIGN_MEETING}.m4a`,
    });
    expect(await jsonBody(res, 404)).toStrictEqual({ ok: false, error: "Meeting not found" });
    expect(writeCount(fake)).toBe(0);
    expect(finalizeInPersonMeeting).not.toHaveBeenCalled();
  });

  it("refuses an audio path outside the caller's own storage prefix", async () => {
    const res = await post({
      kind: "in_person_transcribe",
      id: MEETING_ID,
      audio_path: `${OTHER_USER}/${MEETING_ID}.m4a`,
    });
    expect(await jsonBody(res, 400)).toStrictEqual({ ok: false, error: "Invalid audio path" });
    expect(writeCount(fake)).toBe(0);
    expect(finalizeInPersonMeeting).not.toHaveBeenCalled();
  });

  it("surfaces an update failure as 400 and does not finalize", async () => {
    fake.onUpdate("meetings", () => ({ message: "update denied" }));
    const res = await post({
      kind: "in_person_transcribe",
      id: MEETING_ID,
      audio_path: `${MOBILE_USER}/x.m4a`,
    });
    expect(await jsonBody(res, 400)).toStrictEqual({ ok: false, error: "update denied" });
    expect(finalizeInPersonMeeting).not.toHaveBeenCalled();
  });

  it("turns a finalize failure into a 400 with the message and logs it", async () => {
    finalizeInPersonMeeting.mockRejectedValue(new Error("stt unavailable"));
    const res = await post({
      kind: "in_person_transcribe",
      id: MEETING_ID,
      audio_path: `${MOBILE_USER}/x.m4a`,
    });
    expect(await jsonBody(res, 400)).toStrictEqual({ ok: false, error: "stt unavailable" });
    expect(logError).toHaveBeenCalledWith(
      "mobile_meetings_failed",
      { userId: MOBILE_USER, kind: "in_person_transcribe" },
      expect.any(Error),
    );
  });
});
