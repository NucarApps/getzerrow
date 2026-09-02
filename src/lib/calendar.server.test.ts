// Unit coverage for src/lib/calendar.server.ts: the pure attendee parsers,
// the Calendar error taxonomy (including the Google `reason` sniffed out of
// an error body, which is what tells the UI "enable the API" apart from
// "reconnect"), the paginated event walk and its page cap, and the
// calendar_contacts sync's write shape and failure bookkeeping.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const { getAccessToken, logError } = vi.hoisted(() => ({
  getAccessToken: vi.fn<typeof import("./google-oauth.server").getAccessToken>(),
  logError: vi.fn(),
}));
vi.mock("./google-oauth.server", () => ({ getAccessToken }));
vi.mock("./log.server", () => ({ logError, logInfo: vi.fn(), logAudit: vi.fn() }));

import {
  extractAttendeeEmails,
  extractAttendeePeople,
  CalendarApiError,
  describeCalendarError,
  listCalendarPeople,
  syncCalendarContacts,
} from "./calendar.server";

const self = "me@example.com";

describe("extractAttendeeEmails", () => {
  it("returns attendee emails excluding the account owner", () => {
    const out = extractAttendeeEmails(
      { attendees: [{ email: "a@partner.com" }, { email: self, self: true }] },
      self,
    );
    expect(out).toEqual(["a@partner.com"]);
  });

  it("excludes the owner even when self flag is missing but address matches", () => {
    const out = extractAttendeeEmails(
      { attendees: [{ email: "Me@Example.com" }, { email: "b@partner.com" }] },
      self,
    );
    expect(out).toEqual(["b@partner.com"]);
  });

  it("lowercases and de-duplicates addresses", () => {
    const out = extractAttendeeEmails(
      {
        attendees: [{ email: "Dup@Partner.com" }, { email: "dup@partner.com" }],
        organizer: { email: "DUP@partner.com" },
      },
      self,
    );
    expect(out).toEqual(["dup@partner.com"]);
  });

  it("includes organizer and creator addresses", () => {
    const out = extractAttendeeEmails(
      { organizer: { email: "org@partner.com" }, creator: { email: "creator@partner.com" } },
      self,
    );
    expect(out.sort()).toEqual(["creator@partner.com", "org@partner.com"]);
  });

  it("skips Google resource calendars (rooms / equipment)", () => {
    const out = extractAttendeeEmails(
      {
        attendees: [{ email: "room@resource.calendar.google.com" }, { email: "team@partner.com" }],
      },
      self,
    );
    expect(out).toEqual(["team@partner.com"]);
  });

  it("ignores malformed or empty addresses", () => {
    const out = extractAttendeeEmails(
      { attendees: [{ email: "not-an-email" }, { email: "" }, { email: undefined }] },
      self,
    );
    expect(out).toEqual([]);
  });

  it("returns an empty array for an event with no participants", () => {
    expect(extractAttendeeEmails({}, self)).toEqual([]);
  });
});

describe("CalendarApiError.kind", () => {
  it("maps a disabled-API 403 to api_disabled", () => {
    expect(new CalendarApiError("disabled", 403, "accessNotConfigured").kind).toBe("api_disabled");
    expect(new CalendarApiError("disabled", 403, "SERVICE_DISABLED").kind).toBe("api_disabled");
  });

  it("maps 401 / insufficient scope to reconnect", () => {
    expect(new CalendarApiError("unauth", 401).kind).toBe("reconnect");
    expect(new CalendarApiError("scope", 403, "ACCESS_TOKEN_SCOPE_INSUFFICIENT").kind).toBe(
      "reconnect",
    );
    expect(new CalendarApiError("perm", 403, "insufficientPermissions").kind).toBe("reconnect");
  });

  it("maps quota / rate-limit errors to rate_limited", () => {
    expect(new CalendarApiError("rate", 429).kind).toBe("rate_limited");
    expect(new CalendarApiError("rate", 403, "rateLimitExceeded").kind).toBe("rate_limited");
    expect(new CalendarApiError("quota", 403, "quotaExceeded").kind).toBe("rate_limited");
  });

  it("falls back to unknown for unrecognized failures", () => {
    expect(new CalendarApiError("oops", 500).kind).toBe("unknown");
    expect(new CalendarApiError("net", 0).kind).toBe("unknown");
  });
});

describe("extractAttendeePeople", () => {
  it("captures display name, event start time and title", () => {
    const out = extractAttendeePeople(
      {
        summary: "Project sync",
        start: { dateTime: "2026-05-01T10:00:00Z" },
        attendees: [{ email: "a@partner.com", displayName: "Alice Partner" }],
      },
      self,
    );
    expect(out).toEqual([
      {
        email: "a@partner.com",
        name: "Alice Partner",
        meetingAt: "2026-05-01T10:00:00Z",
        eventTitle: "Project sync",
      },
    ]);
  });

  it("excludes the owner and resource calendars, lowercases emails", () => {
    const out = extractAttendeePeople(
      {
        start: { date: "2026-05-02" },
        attendees: [
          { email: self, self: true },
          { email: "Room-A@resource.calendar.google.com" },
          { email: "B@Partner.com", displayName: "Bob" },
        ],
      },
      self,
    );
    expect(out).toEqual([
      { email: "b@partner.com", name: "Bob", meetingAt: "2026-05-02", eventTitle: null },
    ]);
  });

  it("falls back to the organizer when there are no attendees", () => {
    const out = extractAttendeePeople(
      {
        summary: "1:1",
        start: { dateTime: "2026-06-01T09:00:00Z" },
        organizer: { email: "c@partner.com" },
      },
      self,
    );
    expect(out).toEqual([
      { email: "c@partner.com", name: null, meetingAt: "2026-06-01T09:00:00Z", eventTitle: "1:1" },
    ]);
  });
});

// -- Network-facing paths -------------------------------------------------

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const USER = "user-1";
const NOW = "2026-03-01T12:00:00Z";
const NOW_ISO = "2026-03-01T12:00:00.000Z";
/** timeMin for the 12-month lookback, as the module computes it. */
const LOOKBACK_MIN = new Date(Date.parse(NOW) - 12 * 30 * 24 * 60 * 60 * 1000).toISOString();

const fetchMock = vi.fn<typeof fetch>();

/** A successful events page. */
function page(body: { items?: unknown[]; nextPageToken?: string }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** The query parameters of the nth Calendar request the stub saw. */
function requestParams(n: number): URLSearchParams {
  return new URL(String(fetchMock.mock.calls[n]?.[0])).searchParams;
}

function seedAccount(email: string | null = self) {
  fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: USER, email_address: email }]);
}

beforeEach(() => {
  fake.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal("fetch", fetchMock);
  // Not a "ya29." shaped string: secret scanners flag that prefix as a real
  // Google OAuth token even in a fixture, and the value is never parsed.
  getAccessToken.mockResolvedValue("test-access-token");
  fetchMock.mockResolvedValue(page({ items: [] }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Calendar API failures", () => {
  it("carries Google's error reason out of the response body onto the error", async () => {
    seedAccount();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 403,
            errors: [{ reason: "accessNotConfigured" }],
            status: "PERMISSION_DENIED",
          },
        }),
        { status: 403 },
      ),
    );

    const err = await syncCalendarContacts(ACCOUNT, USER).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CalendarApiError);
    expect((err as CalendarApiError).googleReason).toBe("accessNotConfigured");
    expect((err as CalendarApiError).kind).toBe("api_disabled");
  });

  it("falls back to the top-level status when there is no errors array", async () => {
    seedAccount();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), { status: 429 }),
    );

    const err = await syncCalendarContacts(ACCOUNT, USER).catch((e: unknown) => e);

    expect((err as CalendarApiError).googleReason).toBe("RESOURCE_EXHAUSTED");
    expect((err as CalendarApiError).kind).toBe("rate_limited");
  });

  it("reports no reason when the error body is not JSON", async () => {
    seedAccount();
    fetchMock.mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: 502 }));

    const err = await syncCalendarContacts(ACCOUNT, USER).catch((e: unknown) => e);

    expect((err as CalendarApiError).googleReason).toBeNull();
    expect((err as CalendarApiError).status).toBe(502);
    expect((err as CalendarApiError).kind).toBe("unknown");
  });

  it("turns a transport failure into a status-0 CalendarApiError", async () => {
    seedAccount();
    fetchMock.mockRejectedValue(new Error("socket hang up"));

    const err = await syncCalendarContacts(ACCOUNT, USER).catch((e: unknown) => e);

    expect((err as CalendarApiError).status).toBe(0);
    expect((err as CalendarApiError).message).toContain("network error");
  });

  it("records the human-readable reason on the account before rethrowing", async () => {
    seedAccount();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { errors: [{ reason: "accessNotConfigured" }] } }), {
        status: 403,
      }),
    );

    await expect(syncCalendarContacts(ACCOUNT, USER)).rejects.toThrow(CalendarApiError);

    expect(fake.calls.updates.map((w) => [w.table, w.payload, w.filters])).toStrictEqual([
      [
        "gmail_accounts",
        {
          calendar_sync_error: describeCalendarError(
            new CalendarApiError("x", 403, "accessNotConfigured"),
          ),
        },
        [{ op: "eq", col: "id", value: ACCOUNT, extra: undefined }],
      ],
    ]);
    expect(fake.calls.upserts).toHaveLength(0);
  });
});

describe("describeCalendarError", () => {
  it("explains each failure kind, and anything else generically", () => {
    expect([
      describeCalendarError(new CalendarApiError("x", 403, "accessNotConfigured")),
      describeCalendarError(new CalendarApiError("x", 401)),
      describeCalendarError(new CalendarApiError("x", 429)),
      describeCalendarError(new CalendarApiError("x", 500)),
      describeCalendarError(new Error("something else")),
    ]).toStrictEqual([
      "The Google Calendar API isn't enabled for this connection yet. This is a one-time setup in Google Cloud — once enabled, syncing will work.",
      "Calendar access is missing or expired. Reconnect Google to grant calendar access.",
      "Google is rate-limiting calendar requests right now. Try again in a few minutes.",
      "Couldn't reach Google Calendar. Please try again shortly.",
      "Couldn't sync your calendar. Please try again.",
    ]);
  });
});

describe("syncCalendarContacts", () => {
  it("follows nextPageToken and merges attendees across both pages", async () => {
    seedAccount();
    fetchMock
      .mockResolvedValueOnce(
        page({
          items: [{ attendees: [{ email: "a@partner.com" }, { email: self, self: true }] }],
          nextPageToken: "page-2",
        }),
      )
      .mockResolvedValueOnce(
        page({ items: [{ attendees: [{ email: "A@Partner.com" }, { email: "b@partner.com" }] }] }),
      );

    const result = await syncCalendarContacts(ACCOUNT, USER);

    expect(result).toStrictEqual({ contacts: 2, pages: 2, truncated: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestParams(0).get("pageToken")).toBeNull();
    expect(requestParams(1).get("pageToken")).toBe("page-2");
    expect(requestParams(0).get("timeMin")).toBe(LOOKBACK_MIN);
    expect(requestParams(0).get("singleEvents")).toBe("true");
    expect(requestParams(0).get("maxResults")).toBe("250");
  });

  it("upserts one row per distinct attendee, keyed on account and address", async () => {
    seedAccount();
    fetchMock.mockResolvedValue(
      page({
        items: [
          { attendees: [{ email: "a@partner.com" }] },
          { organizer: { email: "A@PARTNER.com" }, creator: { email: "b@partner.com" } },
        ],
      }),
    );

    await syncCalendarContacts(ACCOUNT, USER);

    expect(fake.calls.upserts.map((w) => [w.table, w.payload, w.options])).toStrictEqual([
      [
        "calendar_contacts",
        [
          {
            user_id: USER,
            gmail_account_id: ACCOUNT,
            email_address: "a@partner.com",
            last_seen_at: NOW_ISO,
          },
          {
            user_id: USER,
            gmail_account_id: ACCOUNT,
            email_address: "b@partner.com",
            last_seen_at: NOW_ISO,
          },
        ],
        { onConflict: "gmail_account_id,email_address" },
      ],
    ]);
    expect(fake.calls.updates[0]?.payload).toStrictEqual({
      calendar_synced_at: NOW_ISO,
      calendar_sync_error: null,
    });
  });

  it("never deletes rows for this account, so a contact seen once stays cached", async () => {
    seedAccount();
    fake.seed("calendar_contacts", [
      { user_id: USER, gmail_account_id: ACCOUNT, email_address: "gone@partner.com" },
    ]);
    fetchMock.mockResolvedValue(page({ items: [{ attendees: [{ email: "a@partner.com" }] }] }));

    await syncCalendarContacts(ACCOUNT, USER);

    expect(fake.calls.deletes).toStrictEqual([]);
  });

  it("stamps the account and writes no contacts when the calendar is empty", async () => {
    seedAccount();

    await expect(syncCalendarContacts(ACCOUNT, USER)).resolves.toStrictEqual({
      contacts: 0,
      pages: 1,
      truncated: false,
    });
    expect(fake.calls.upserts).toHaveLength(0);
    expect(fake.calls.updates).toHaveLength(1);
  });

  it("reports truncated after the page cap when Google still offers more", async () => {
    seedAccount();
    // A fresh Response per call: a body can only be read once.
    fetchMock.mockImplementation(async () => page({ items: [], nextPageToken: "always-more" }));

    const result = await syncCalendarContacts(ACCOUNT, USER);

    expect(result).toStrictEqual({ contacts: 0, pages: 12, truncated: true });
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it("logs but does not fail the run when the contacts upsert is rejected", async () => {
    seedAccount();
    fetchMock.mockResolvedValue(page({ items: [{ attendees: [{ email: "a@partner.com" }] }] }));
    fake.onUpsert("calendar_contacts", () => ({ message: "upsert denied" }));

    await expect(syncCalendarContacts(ACCOUNT, USER)).resolves.toMatchObject({ contacts: 1 });

    expect(logError.mock.calls[0]?.slice(0, 2)).toStrictEqual([
      "calendar.upsert_failed",
      { account_id: ACCOUNT, user_id: USER, count: 1 },
    ]);
    // The success stamp still lands — the sync itself worked.
    expect(fake.calls.updates[0]?.payload).toMatchObject({ calendar_sync_error: null });
  });

  it("keeps every attendee when the account has no stored address to exclude", async () => {
    seedAccount(null);
    fetchMock.mockResolvedValue(
      page({ items: [{ attendees: [{ email: self }, { email: "a@partner.com" }] }] }),
    );

    await expect(syncCalendarContacts(ACCOUNT, USER)).resolves.toMatchObject({ contacts: 2 });
  });
});

describe("listCalendarPeople", () => {
  it("asks for a past window and keeps each person's most recent meeting", async () => {
    seedAccount();
    fetchMock.mockResolvedValue(
      page({
        items: [
          {
            summary: "Kickoff",
            start: { dateTime: "2026-01-01T10:00:00Z" },
            attendees: [{ email: "a@partner.com", displayName: "Alice" }],
          },
          {
            summary: "Review",
            start: { dateTime: "2026-02-01T10:00:00Z" },
            attendees: [{ email: "a@partner.com" }],
          },
        ],
      }),
    );

    const people = await listCalendarPeople(ACCOUNT, { when: "past" });

    expect(people).toStrictEqual([
      {
        email: "a@partner.com",
        name: "Alice",
        meetingAt: "2026-02-01T10:00:00Z",
        eventTitle: "Review",
      },
    ]);
    expect(requestParams(0).get("timeMin")).toBe(LOOKBACK_MIN);
    expect(requestParams(0).get("timeMax")).toBe(NOW_ISO);
  });

  it("asks for an upcoming window and keeps each person's soonest meeting", async () => {
    seedAccount();
    fetchMock.mockResolvedValue(
      page({
        items: [
          {
            summary: "Later",
            start: { dateTime: "2026-05-01T10:00:00Z" },
            attendees: [{ email: "a@partner.com" }],
          },
          {
            summary: "Sooner",
            start: { dateTime: "2026-03-05T10:00:00Z" },
            attendees: [{ email: "a@partner.com", displayName: "Alice" }],
          },
        ],
      }),
    );

    const people = await listCalendarPeople(ACCOUNT, { when: "upcoming" });

    expect(people).toStrictEqual([
      {
        email: "a@partner.com",
        name: "Alice",
        meetingAt: "2026-03-05T10:00:00Z",
        eventTitle: "Sooner",
      },
    ]);
    expect(requestParams(0).get("timeMin")).toBe(NOW_ISO);
    expect(requestParams(0).get("timeMax")).toBe(
      new Date(Date.parse(NOW) + 3 * 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("merges people across pages and writes nothing", async () => {
    seedAccount();
    fetchMock
      .mockResolvedValueOnce(
        page({ items: [{ attendees: [{ email: "a@partner.com" }] }], nextPageToken: "page-2" }),
      )
      .mockResolvedValueOnce(page({ items: [{ attendees: [{ email: "b@partner.com" }] }] }));

    const people = await listCalendarPeople(ACCOUNT, { when: "past" });

    expect(people.map((p) => p.email)).toStrictEqual(["a@partner.com", "b@partner.com"]);
    expect(requestParams(1).get("pageToken")).toBe("page-2");
    expect(writeCount(fake)).toBe(0);
  });

  it("stops at the page cap rather than following an endless token", async () => {
    seedAccount();
    // A fresh Response per call: a body can only be read once.
    fetchMock.mockImplementation(async () => page({ items: [], nextPageToken: "always-more" }));

    await expect(listCalendarPeople(ACCOUNT, { when: "past" })).resolves.toStrictEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });
});
