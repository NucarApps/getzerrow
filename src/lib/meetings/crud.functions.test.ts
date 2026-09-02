// Unit tests for the meeting CRUD server functions
// (src/lib/meetings/crud.functions.ts). Every handler here reads and
// writes through `context.supabase` — the user-scoped (RLS) client — so
// cross-tenant denial is expressed as "with only the rows RLS would
// expose, the call fails and writes nothing" (`// RLS-RELIANCE:` below).
// Contracts pinned: the read filters and ordering, that deleteMeeting
// pulls a live bot out of the call before deleting the row (and deletes
// anyway when that fails), and that every generate/regenerate path refuses
// before spending an AI call when there is nothing to work from.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { callWithRlsClient } from "@/lib/__fixtures__/rls-server-fn";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));

const {
  leaveBot,
  computeCanResendBot,
  generateMeetingTitle,
  generateMeetingBreakdown,
  transcriptSegmentsToText,
  logError,
} = vi.hoisted(() => ({
  leaveBot: vi.fn<typeof import("../recall.server").leaveBot>(),
  computeCanResendBot: vi.fn<typeof import("../meetings-autojoin.server").computeCanResendBot>(),
  generateMeetingTitle: vi.fn<typeof import("../meetings.server").generateMeetingTitle>(),
  generateMeetingBreakdown: vi.fn<typeof import("../meetings.server").generateMeetingBreakdown>(),
  transcriptSegmentsToText: vi.fn<typeof import("../meetings.server").transcriptSegmentsToText>(),
  logError: vi.fn(),
}));

vi.mock("../recall.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../recall.server")>();
  return { ...actual, leaveBot };
});
vi.mock("../meetings-autojoin.server", () => ({ computeCanResendBot }));
vi.mock("../meetings.server", () => ({
  generateMeetingTitle,
  generateMeetingBreakdown,
  transcriptSegmentsToText,
}));
vi.mock("../log.server", () => ({ logError, logInfo: vi.fn(), logAudit: vi.fn() }));

import {
  deleteMeeting,
  generateTitleForMeeting,
  getMeeting,
  listMeetings,
  listMeetingsForContact,
  regenerateMeetingSummary,
  renameMeeting,
} from "./crud.functions";

const MEETING = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const BOT = "bot_abc";

const call = <F extends (args: never) => Promise<unknown>>(fn: F) =>
  callWithRlsClient(fn, { fake });

beforeEach(() => {
  fake.reset();
  leaveBot.mockResolvedValue(undefined);
  computeCanResendBot.mockReturnValue(false);
  generateMeetingTitle.mockResolvedValue("Quarterly review");
  generateMeetingBreakdown.mockResolvedValue("## Decisions\n- ship it");
  transcriptSegmentsToText.mockReturnValue("Ada: ship it");
});

describe("listMeetings", () => {
  it("returns the newest meetings first, annotated with the resend decision", async () => {
    fake.seed("meetings", [
      {
        id: OTHER,
        user_id: TEST_USER,
        title: "Older",
        meeting_url: null,
        platform: null,
        status: "done",
        source: "link",
        scheduled_start: null,
        started_at: null,
        ended_at: null,
        recording_url: null,
        summary: null,
        recall_bot_id: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: MEETING,
        user_id: TEST_USER,
        title: "Newer",
        meeting_url: "https://acme.zoom.us/j/1",
        platform: "zoom",
        status: "failed",
        source: "link",
        scheduled_start: "2026-02-02T10:00:00Z",
        started_at: null,
        ended_at: null,
        recording_url: null,
        summary: null,
        recall_bot_id: BOT,
        created_at: "2026-02-02T00:00:00Z",
      },
    ]);
    computeCanResendBot.mockImplementation((m) => m.status === "failed");

    const result = await call(listMeetings)();

    expect(result.meetings.map((m) => [m.title, m.canResendBot])).toStrictEqual([
      ["Newer", true],
      ["Older", false],
    ]);
    expect(computeCanResendBot.mock.calls[0]?.[0]).toStrictEqual({
      recallBotId: BOT,
      meetingUrl: "https://acme.zoom.us/j/1",
      status: "failed",
      recordingUrl: null,
      scheduledStart: "2026-02-02T10:00:00Z",
    });
  });

  it("surfaces a failing read instead of returning an empty list", async () => {
    fake.onSelect("meetings", () => ({ message: "permission denied for table meetings" }));

    await expect(call(listMeetings)()).rejects.toThrow("permission denied for table meetings");
  });
});

describe("listMeetingsForContact", () => {
  it("filters the join by the requested contact and sorts newest first", async () => {
    fake.seedRaw("meeting_participants", [
      {
        meeting_id: MEETING,
        contact_id: CONTACT,
        meetings: {
          id: MEETING,
          title: "Kickoff",
          status: "done",
          scheduled_start: null,
          created_at: "2026-01-01T00:00:00Z",
          summary: null,
        },
      },
      {
        meeting_id: OTHER,
        contact_id: CONTACT,
        meetings: {
          id: OTHER,
          title: "Follow-up",
          status: "done",
          scheduled_start: null,
          created_at: "2026-02-01T00:00:00Z",
          summary: null,
        },
      },
    ]);

    const result = await call(listMeetingsForContact)({ data: { contactId: CONTACT } });

    expect(result.meetings.map((m) => m.title)).toStrictEqual(["Follow-up", "Kickoff"]);
    const read = fake.calls.selects.find((s) => s.table === "meeting_participants");
    expect(read?.filters).toStrictEqual([
      { op: "eq", col: "contact_id", value: CONTACT, extra: undefined },
    ]);
  });
});

describe("getMeeting", () => {
  // RLS-RELIANCE: the meetings read runs on context.supabase, so a meeting
  // belonging to someone else is simply not visible.
  it("refuses a meeting the caller cannot see", async () => {
    await expect(call(getMeeting)({ data: { id: MEETING } })).rejects.toThrow("Meeting not found");
    expect(writeCount(fake)).toBe(0);
  });

  it("returns the meeting with only its own participants", async () => {
    fake.seed("meetings", [{ id: MEETING, user_id: TEST_USER, title: "Kickoff" }]);
    fake.seed("meeting_participants", [
      { id: "p1", meeting_id: MEETING, email: "ada@acme.com", name: "Ada", contact_id: CONTACT },
      { id: "p2", meeting_id: OTHER, email: "eve@evil.com", name: "Eve", contact_id: null },
    ]);

    const result = await call(getMeeting)({ data: { id: MEETING } });

    expect(result.meeting).toMatchObject({ id: MEETING, title: "Kickoff" });
    expect(result.participants).toStrictEqual([
      { id: "p1", meeting_id: MEETING, email: "ada@acme.com", name: "Ada", contact_id: CONTACT },
    ]);
  });
});

describe("deleteMeeting", () => {
  // RLS-RELIANCE: an invisible meeting is never deleted and no bot is touched.
  it("refuses a meeting the caller cannot see and leaves no bot", async () => {
    await expect(call(deleteMeeting)({ data: { id: MEETING } })).rejects.toThrow(
      "Meeting not found",
    );
    expect(leaveBot).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("pulls a live bot out of the call before deleting the row", async () => {
    fake.seed("meetings", [
      { id: MEETING, user_id: TEST_USER, recall_bot_id: BOT, status: "recording" },
    ]);

    const result = await call(deleteMeeting)({ data: { id: MEETING } });

    expect(result).toStrictEqual({ ok: true });
    expect(leaveBot.mock.calls).toStrictEqual([[BOT]]);
    expect(fake.calls.deletes.map((w) => [w.table, w.filters])).toStrictEqual([
      ["meetings", [{ op: "eq", col: "id", value: MEETING, extra: undefined }]],
    ]);
  });

  it("does not disturb a bot for a meeting that already finished", async () => {
    fake.seed("meetings", [
      { id: MEETING, user_id: TEST_USER, recall_bot_id: BOT, status: "done" },
    ]);

    await call(deleteMeeting)({ data: { id: MEETING } });

    expect(leaveBot).not.toHaveBeenCalled();
    expect(fake.calls.deletes).toHaveLength(1);
  });

  it("deletes the row anyway when leaving the bot fails, logging it", async () => {
    fake.seed("meetings", [
      { id: MEETING, user_id: TEST_USER, recall_bot_id: BOT, status: "joining" },
    ]);
    leaveBot.mockRejectedValue(new Error("Recall API 500"));

    await expect(call(deleteMeeting)({ data: { id: MEETING } })).resolves.toStrictEqual({
      ok: true,
    });
    expect(logError.mock.calls[0]?.[0]).toBe("meeting_leave_bot_failed");
    expect(fake.calls.deletes).toHaveLength(1);
  });

  it("surfaces a failing delete", async () => {
    fake.seed("meetings", [
      { id: MEETING, user_id: TEST_USER, recall_bot_id: null, status: "done" },
    ]);
    fake.onDelete("meetings", () => ({ message: "delete denied" }));

    await expect(call(deleteMeeting)({ data: { id: MEETING } })).rejects.toThrow("delete denied");
  });
});

describe("renameMeeting", () => {
  // RLS-RELIANCE: this handler does NOT read the row first — the UPDATE is
  // filtered on id alone, so RLS on context.supabase is the ONLY thing
  // keeping a caller off someone else's meeting. Asserted here so the
  // filter set can never silently lose the user scope RLS supplies.
  it("filters the update by id only, relying entirely on RLS for ownership", async () => {
    const result = await call(renameMeeting)({ data: { id: MEETING, title: "  Kickoff  " } });

    expect(result).toStrictEqual({ title: "Kickoff" });
    expect(fake.calls.updates.map((w) => [w.table, w.payload, w.filters])).toStrictEqual([
      [
        "meetings",
        { title: "Kickoff" },
        [{ op: "eq", col: "id", value: MEETING, extra: undefined }],
      ],
    ]);
  });

  it("clears the title when given only whitespace", async () => {
    const result = await call(renameMeeting)({ data: { id: MEETING, title: "   " } });

    expect(result).toStrictEqual({ title: null });
    expect(fake.calls.updates[0]?.payload).toStrictEqual({ title: null });
  });

  it("surfaces a rejected update", async () => {
    fake.onUpdate("meetings", () => ({ message: "update denied" }));

    await expect(call(renameMeeting)({ data: { id: MEETING, title: "x" } })).rejects.toThrow(
      "update denied",
    );
  });
});

describe("generateTitleForMeeting", () => {
  it("refuses a meeting the caller cannot see without calling the model", async () => {
    await expect(call(generateTitleForMeeting)({ data: { id: MEETING } })).rejects.toThrow(
      "Meeting not found",
    );
    expect(generateMeetingTitle).not.toHaveBeenCalled();
  });

  it("refuses when there is neither a summary nor a transcript to work from", async () => {
    fake.seed("meetings", [{ id: MEETING, user_id: TEST_USER, summary: "   ", transcript: [] }]);

    await expect(call(generateTitleForMeeting)({ data: { id: MEETING } })).rejects.toThrow(
      "Add a recording first — there's nothing to base a title on yet.",
    );
    expect(generateMeetingTitle).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("falls back to the transcript text when the summary is blank", async () => {
    fake.seed("meetings", [
      {
        id: MEETING,
        user_id: TEST_USER,
        summary: null,
        transcript: [{ text: "we agreed" }, { text: "to ship" }, {}],
      },
    ]);

    const result = await call(generateTitleForMeeting)({ data: { id: MEETING } });

    expect(generateMeetingTitle.mock.calls).toStrictEqual([["we agreed to ship"]]);
    expect(result).toStrictEqual({ title: "Quarterly review" });
    expect(fake.calls.updates[0]?.payload).toStrictEqual({ title: "Quarterly review" });
  });

  it("does not write a title when the model returns nothing", async () => {
    fake.seed("meetings", [
      { id: MEETING, user_id: TEST_USER, summary: "a recap", transcript: null },
    ]);
    generateMeetingTitle.mockResolvedValue(null);

    await expect(call(generateTitleForMeeting)({ data: { id: MEETING } })).rejects.toThrow(
      "Couldn't generate a title. Please try again.",
    );
    expect(writeCount(fake)).toBe(0);
  });
});

describe("regenerateMeetingSummary", () => {
  const transcript = [{ speaker: "Ada", text: "we should ship the release this week", start: 0 }];

  it("refuses a meeting the caller cannot see without calling the model", async () => {
    await expect(call(regenerateMeetingSummary)({ data: { id: MEETING } })).rejects.toThrow(
      "Meeting not found",
    );
    expect(generateMeetingBreakdown).not.toHaveBeenCalled();
  });

  it("refuses when the meeting has no transcript yet", async () => {
    fake.seed("meetings", [{ id: MEETING, user_id: TEST_USER, transcript: [] }]);

    await expect(call(regenerateMeetingSummary)({ data: { id: MEETING } })).rejects.toThrow(
      "No transcript yet — record the meeting first.",
    );
    expect(generateMeetingBreakdown).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("stores the AI breakdown built from the transcript text", async () => {
    fake.seed("meetings", [{ id: MEETING, user_id: TEST_USER, transcript }]);

    const result = await call(regenerateMeetingSummary)({ data: { id: MEETING } });

    expect(transcriptSegmentsToText.mock.calls).toStrictEqual([[transcript]]);
    expect(result).toStrictEqual({ summary: "## Decisions\n- ship it" });
    expect(fake.calls.updates.map((w) => [w.payload, w.filters])).toStrictEqual([
      [
        { summary: "## Decisions\n- ship it" },
        [{ op: "eq", col: "id", value: MEETING, extra: undefined }],
      ],
    ]);
  });

  it("falls back to the extractive digest when the AI returns nothing", async () => {
    fake.seed("meetings", [{ id: MEETING, user_id: TEST_USER, transcript }]);
    generateMeetingBreakdown.mockResolvedValue(null);

    const result = await call(regenerateMeetingSummary)({ data: { id: MEETING } });

    expect(result).toStrictEqual({
      summary: "Key moments\n• Ada: we should ship the release this week",
    });
  });
});
