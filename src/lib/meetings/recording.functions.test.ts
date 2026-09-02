// Unit tests for the meeting recording server functions
// (src/lib/meetings/recording.functions.ts). Contracts pinned here:
//
//   - recordFromLink refuses a foreign gmail_account_id and a blocked
//     attendee BEFORE createBot — a Recall bot costs money and joins a
//     third party's call, so the "no bot was created" assertion is the
//     point of these tests, not an incidental detail;
//   - a Recall failure is reported as a user-facing error with the original
//     error preserved as `cause`, and no meetings row is written;
//   - the meetings insert carries the full row shape (user id, bot id,
//     detected platform, source);
//   - stopMeeting / resendMeetingBot treat leaveBot as best-effort but do
//     NOT swallow a createBot failure;
//   - transcribeInPersonMeeting rejects a storage path outside the caller's
//     own {userId}/ prefix.
//
// These handlers read and write through `context.supabase` (the RLS
// client), so cross-tenant denial is expressed as "with only the rows RLS
// would expose, the call fails and writes nothing" — see the
// `// RLS-RELIANCE:` comments.

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
  createBot,
  leaveBot,
  findBlockedAttendeeForMeetingUrl,
  loadBotConfig,
  syncMeetingFromRecall,
  refreshMeetingRecording,
  finalizeInPersonMeeting,
  buildRecordingStreamPath,
  logError,
} = vi.hoisted(() => ({
  createBot: vi.fn<typeof import("../recall.server").createBot>(),
  leaveBot: vi.fn<typeof import("../recall.server").leaveBot>(),
  findBlockedAttendeeForMeetingUrl:
    vi.fn<typeof import("../meetings-autojoin.server").findBlockedAttendeeForMeetingUrl>(),
  loadBotConfig: vi.fn<typeof import("../meetings.server").loadBotConfig>(),
  syncMeetingFromRecall: vi.fn(async (_m: unknown) => "done"),
  refreshMeetingRecording: vi.fn(async (_id: string) => ({
    recordingUrl: "https://recall/rec.mp4" as string | null,
    hasRecording: true,
    hasTranscript: true,
    hasSummary: false,
  })),
  finalizeInPersonMeeting: vi.fn(async (_id: string) => "done"),
  buildRecordingStreamPath: vi.fn((id: string) => `/api/public/meeting-recording?m=${id}`),
  logError: vi.fn(),
}));

vi.mock("../recall.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../recall.server")>();
  return { ...actual, createBot, leaveBot };
});
vi.mock("../meetings-autojoin.server", () => ({ findBlockedAttendeeForMeetingUrl }));
vi.mock("../meetings.server", () => ({
  loadBotConfig,
  syncMeetingFromRecall,
  refreshMeetingRecording,
  finalizeInPersonMeeting,
}));
vi.mock("../meeting-stream.server", () => ({ buildRecordingStreamPath }));
vi.mock("../log.server", () => ({ logError, logInfo: vi.fn(), logAudit: vi.fn() }));

import {
  createInPersonMeeting,
  getRecordingStreamUrl,
  recordFromLink,
  refreshRecording,
  resendMeetingBot,
  stopMeeting,
  syncMeeting,
  transcribeInPersonMeeting,
} from "./recording.functions";

const MEETING = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const FOREIGN_ACCOUNT = "33333333-3333-4333-8333-333333333333";
const BOT = "bot_abc";
const ZOOM = "https://acme.zoom.us/j/9876543210";

const BOT_CONFIG = {
  botName: "Atzro Notetaker",
  chatMessage: null,
  chatResendOnJoin: true,
  imageB64: null,
  autoLeaveEnabled: true,
  autoLeaveMinutes: 5,
};

const call = <F extends (args: never) => Promise<unknown>>(fn: F) =>
  callWithRlsClient(fn, { fake });

beforeEach(() => {
  fake.reset();
  createBot.mockResolvedValue({ id: BOT });
  leaveBot.mockResolvedValue(undefined);
  findBlockedAttendeeForMeetingUrl.mockResolvedValue(null);
  loadBotConfig.mockResolvedValue(BOT_CONFIG);
  syncMeetingFromRecall.mockResolvedValue("done");
  finalizeInPersonMeeting.mockResolvedValue("done");
});

describe("recordFromLink", () => {
  it("rejects input with no meeting link before touching the DB", async () => {
    await expect(
      call(recordFromLink)({ data: { meetingUrl: "lunch tomorrow" } }),
    ).rejects.toThrow();
    expect(createBot).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  // RLS-RELIANCE: ownership of gmail_accounts is enforced by RLS on
  // context.supabase, so a foreign account id simply resolves to no row.
  // What this asserts is that the app then refuses BEFORE spending a bot.
  it("refuses a gmail account the caller cannot see, without creating a bot", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER }]);

    await expect(
      call(recordFromLink)({ data: { meetingUrl: ZOOM, accountId: FOREIGN_ACCOUNT } }),
    ).rejects.toThrow("Account not found");
    expect(createBot, "a denied call must never create a paid Recall bot").not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("refuses when an attendee is on the don't-record list, without creating a bot", async () => {
    findBlockedAttendeeForMeetingUrl.mockResolvedValue("legal@acme.com");

    await expect(call(recordFromLink)({ data: { meetingUrl: ZOOM } })).rejects.toThrow(
      "Not recorded — legal@acme.com is on your don't-record list.",
    );
    expect(createBot).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("creates the bot from the caller's saved config and inserts the full meeting row", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER }]);
    fake.onInsert("meetings", () => ({ data: { id: MEETING } }));

    const result = await call(recordFromLink)({
      data: { meetingUrl: `Join here ${ZOOM}`, title: "Standup", accountId: ACCOUNT },
    });

    expect(result).toStrictEqual({ id: MEETING });
    expect(createBot.mock.calls).toStrictEqual([
      [
        {
          meetingUrl: ZOOM,
          botName: "Atzro Notetaker",
          chatMessage: null,
          chatResendOnJoin: true,
          imageB64: null,
          everyoneLeftTimeoutSec: 300,
          inCallNotRecordingTimeoutSec: 300,
        },
      ],
    ]);
    expect(fake.calls.inserts.map((w) => [w.table, w.payload])).toStrictEqual([
      [
        "meetings",
        {
          user_id: TEST_USER,
          gmail_account_id: ACCOUNT,
          recall_bot_id: BOT,
          title: "Standup",
          meeting_url: ZOOM,
          platform: "zoom",
          status: "joining",
          source: "link",
        },
      ],
    ]);
  });

  it("passes null timeouts when auto-leave is disabled", async () => {
    loadBotConfig.mockResolvedValue({ ...BOT_CONFIG, autoLeaveEnabled: false });
    fake.onInsert("meetings", () => ({ data: { id: MEETING } }));

    await call(recordFromLink)({ data: { meetingUrl: ZOOM } });

    expect(createBot.mock.calls[0]?.[0]).toMatchObject({
      everyoneLeftTimeoutSec: null,
      inCallNotRecordingTimeoutSec: null,
    });
  });

  it("reports a Recall failure without inserting a meeting, keeping the cause", async () => {
    const apiError = new Error("Recall API 502 on /bot: upstream");
    createBot.mockRejectedValue(apiError);

    await expect(call(recordFromLink)({ data: { meetingUrl: ZOOM } })).rejects.toThrow(
      "Could not start the recording bot. Check the link and try again.",
    );
    await expect(call(recordFromLink)({ data: { meetingUrl: ZOOM } })).rejects.toHaveProperty(
      "cause",
      apiError,
    );
    expect(writeCount(fake)).toBe(0);
    expect(logError.mock.calls[0]?.[0]).toBe("meeting_record_from_link_failed");
  });

  it("surfaces a failing meetings insert as an error", async () => {
    fake.onInsert("meetings", () => ({ message: "insert denied by RLS" }));

    await expect(call(recordFromLink)({ data: { meetingUrl: ZOOM } })).rejects.toThrow(
      "insert denied by RLS",
    );
  });
});

describe("syncMeeting", () => {
  // RLS-RELIANCE: the meetings read runs on context.supabase; a meeting the
  // caller cannot see is simply absent.
  it("refuses a meeting the caller cannot see and never calls Recall", async () => {
    await expect(call(syncMeeting)({ data: { id: MEETING } })).rejects.toThrow("Meeting not found");
    expect(syncMeetingFromRecall).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("short-circuits a terminal meeting without calling Recall", async () => {
    fake.seed("meetings", [
      { id: MEETING, user_id: TEST_USER, recall_bot_id: BOT, status: "done", title: "Standup" },
    ]);

    const result = await call(syncMeeting)({ data: { id: MEETING } });

    expect(result).toStrictEqual({ status: "done" });
    expect(syncMeetingFromRecall).not.toHaveBeenCalled();
  });

  it("syncs a live meeting from Recall and returns the new status", async () => {
    fake.seed("meetings", [
      { id: MEETING, user_id: TEST_USER, recall_bot_id: BOT, status: "joining", title: "Standup" },
    ]);
    syncMeetingFromRecall.mockResolvedValue("recording");

    const result = await call(syncMeeting)({ data: { id: MEETING } });

    expect(result).toStrictEqual({ status: "recording" });
    expect(syncMeetingFromRecall.mock.calls[0]?.[0]).toStrictEqual({
      id: MEETING,
      user_id: TEST_USER,
      recall_bot_id: BOT,
      status: "joining",
      title: "Standup",
    });
  });
});

describe("stopMeeting", () => {
  // RLS-RELIANCE: as above — no visible row means no bot is disturbed.
  it("refuses a meeting the caller cannot see and never leaves a bot", async () => {
    await expect(call(stopMeeting)({ data: { id: MEETING } })).rejects.toThrow("Meeting not found");
    expect(leaveBot).not.toHaveBeenCalled();
  });

  it("refuses a meeting that has no bot to stop", async () => {
    fake.seed("meetings", [
      { id: MEETING, user_id: TEST_USER, recall_bot_id: null, status: "joining", title: null },
    ]);

    await expect(call(stopMeeting)({ data: { id: MEETING } })).rejects.toThrow(
      "This recording can't be stopped remotely.",
    );
    expect(leaveBot).not.toHaveBeenCalled();
  });

  it("finalizes anyway when leaveBot fails, logging the failure", async () => {
    fake.seed("meetings", [
      { id: MEETING, user_id: TEST_USER, recall_bot_id: BOT, status: "recording", title: null },
    ]);
    leaveBot.mockRejectedValue(new Error("Recall API 500 on /bot/bot_abc/leave_call"));
    syncMeetingFromRecall.mockResolvedValue("done");

    const result = await call(stopMeeting)({ data: { id: MEETING } });

    expect(result).toStrictEqual({ status: "done" });
    expect(leaveBot.mock.calls).toStrictEqual([[BOT]]);
    expect(logError.mock.calls[0]?.[0]).toBe("meeting_stop_leave_failed");
  });
});

describe("resendMeetingBot", () => {
  it("refuses a meeting that already has a recording", async () => {
    fake.seed("meetings", [
      {
        id: MEETING,
        recall_bot_id: BOT,
        meeting_url: ZOOM,
        status: "done",
        recording_url: "https://recall/rec.mp4",
        scheduled_start: null,
        title: null,
      },
    ]);

    await expect(call(resendMeetingBot)({ data: { id: MEETING } })).rejects.toThrow(
      "This meeting already has a recording.",
    );
    expect(createBot).not.toHaveBeenCalled();
  });

  it("refuses a meeting whose start is more than two hours past", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    fake.seed("meetings", [
      {
        id: MEETING,
        recall_bot_id: null,
        meeting_url: ZOOM,
        status: "failed",
        recording_url: null,
        scheduled_start: "2026-03-01T09:30:00Z",
        title: null,
      },
    ]);

    await expect(call(resendMeetingBot)({ data: { id: MEETING } })).rejects.toThrow(
      "Too late to send the notetaker — this meeting is over.",
    );
    expect(createBot).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("schedules a future meeting's bot to join at start and marks it scheduled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    fake.seed("meetings", [
      {
        id: MEETING,
        recall_bot_id: BOT,
        meeting_url: ZOOM,
        status: "failed",
        recording_url: null,
        scheduled_start: "2026-03-01T13:00:00Z",
        title: null,
      },
    ]);

    const result = await call(resendMeetingBot)({ data: { id: MEETING } });

    expect(result).toStrictEqual({ status: "scheduled", recallBotId: BOT });
    expect(leaveBot.mock.calls).toStrictEqual([[BOT]]);
    expect(createBot.mock.calls[0]?.[0]).toMatchObject({
      meetingUrl: ZOOM,
      joinAt: "2026-03-01T13:00:00Z",
    });
    expect(fake.calls.updates.map((w) => [w.table, w.payload, w.filters])).toStrictEqual([
      [
        "meetings",
        { recall_bot_id: BOT, status: "scheduled" },
        [{ op: "eq", col: "id", value: MEETING, extra: undefined }],
      ],
    ]);
    vi.useRealTimers();
  });

  it("does not update the meeting when Recall refuses the new bot", async () => {
    fake.seed("meetings", [
      {
        id: MEETING,
        recall_bot_id: null,
        meeting_url: ZOOM,
        status: "failed",
        recording_url: null,
        scheduled_start: null,
        title: null,
      },
    ]);
    createBot.mockRejectedValue(new Error("Recall API 429 on /bot: rate limited"));

    await expect(call(resendMeetingBot)({ data: { id: MEETING } })).rejects.toThrow(
      "Couldn't reach the meeting service. Try again in a moment.",
    );
    expect(writeCount(fake)).toBe(0);
    expect(logError.mock.calls[0]?.[0]).toBe("meeting_resend_create_failed");
  });
});

describe("refreshRecording", () => {
  it("reports an in-person recording from the row without calling Recall", async () => {
    fake.seed("meetings", [
      {
        id: MEETING,
        recall_bot_id: null,
        audio_storage_path: `${TEST_USER}/${MEETING}.webm`,
        video_storage_path: null,
        transcript: "hello",
        summary: null,
        status: "done",
      },
    ]);

    const result = await call(refreshRecording)({ data: { id: MEETING } });

    expect(result).toStrictEqual({
      recordingUrl: null,
      hasRecording: true,
      hasTranscript: true,
      hasSummary: false,
    });
    expect(refreshMeetingRecording).not.toHaveBeenCalled();
  });

  it("reports nothing for a meeting with neither a bot nor stored media", async () => {
    fake.seed("meetings", [
      {
        id: MEETING,
        recall_bot_id: null,
        audio_storage_path: null,
        video_storage_path: null,
        transcript: null,
        summary: null,
        status: "failed",
      },
    ]);

    const result = await call(refreshRecording)({ data: { id: MEETING } });

    expect(result).toStrictEqual({
      recordingUrl: null,
      hasRecording: false,
      hasTranscript: false,
      hasSummary: false,
    });
  });
});

describe("getRecordingStreamUrl", () => {
  // RLS-RELIANCE: an unseen meeting yields no signed stream token at all.
  it("refuses to mint a stream token for a meeting the caller cannot see", async () => {
    await expect(call(getRecordingStreamUrl)({ data: { id: MEETING } })).rejects.toThrow(
      "Meeting not found",
    );
    expect(buildRecordingStreamPath).not.toHaveBeenCalled();
  });

  it("labels a stored audio-only recording as audio", async () => {
    fake.seed("meetings", [
      {
        id: MEETING,
        recall_bot_id: null,
        recording_url: null,
        audio_storage_path: `${TEST_USER}/${MEETING}.webm`,
        video_storage_path: null,
      },
    ]);

    const result = await call(getRecordingStreamUrl)({ data: { id: MEETING } });

    expect(result).toStrictEqual({
      streamUrl: `/api/public/meeting-recording?m=${MEETING}`,
      kind: "audio",
    });
  });

  it("returns no stream url when there is nothing to play", async () => {
    fake.seed("meetings", [
      {
        id: MEETING,
        recall_bot_id: null,
        recording_url: null,
        audio_storage_path: null,
        video_storage_path: null,
      },
    ]);

    const result = await call(getRecordingStreamUrl)({ data: { id: MEETING } });

    expect(result).toStrictEqual({ streamUrl: null, kind: "video" });
    expect(buildRecordingStreamPath).not.toHaveBeenCalled();
  });
});

describe("createInPersonMeeting", () => {
  it("refuses an account the caller cannot see and writes nothing", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: TEST_USER }]);

    await expect(
      call(createInPersonMeeting)({ data: { accountId: FOREIGN_ACCOUNT } }),
    ).rejects.toThrow("Account not found");
    expect(writeCount(fake)).toBe(0);
  });

  it("inserts the row and returns upload paths under the caller's own prefix", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    fake.onInsert("meetings", () => ({ data: { id: MEETING } }));

    const result = await call(createInPersonMeeting)({
      data: { title: "  Coffee  ", ext: "m4a", withVideo: true, videoExt: "mp4" },
    });

    expect(result).toStrictEqual({
      id: MEETING,
      audioPath: `${TEST_USER}/${MEETING}.m4a`,
      videoPath: `${TEST_USER}/${MEETING}.video.mp4`,
    });
    expect(fake.calls.inserts[0]?.payload).toStrictEqual({
      user_id: TEST_USER,
      meeting_url: null,
      platform: "in_person",
      source: "in_person",
      status: "processing",
      title: "Coffee",
      started_at: "2026-03-01T12:00:00.000Z",
      gmail_account_id: null,
      calendar_event_id: null,
      scheduled_start: null,
    });
    vi.useRealTimers();
  });
});

describe("transcribeInPersonMeeting", () => {
  // RLS-RELIANCE: the meetings read runs on context.supabase.
  it("refuses a meeting the caller cannot see", async () => {
    await expect(
      call(transcribeInPersonMeeting)({
        data: { id: MEETING, audioPath: `${TEST_USER}/${MEETING}.webm` },
      }),
    ).rejects.toThrow("Meeting not found");
    expect(writeCount(fake)).toBe(0);
    expect(finalizeInPersonMeeting).not.toHaveBeenCalled();
  });

  it("refuses an audio path outside the caller's own storage prefix", async () => {
    fake.seed("meetings", [{ id: MEETING, source: "in_person" }]);

    await expect(
      call(transcribeInPersonMeeting)({
        data: { id: MEETING, audioPath: `someone-else/${MEETING}.webm` },
      }),
    ).rejects.toThrow("Invalid audio path");
    expect(writeCount(fake)).toBe(0);
  });

  it("refuses a video path outside the caller's own storage prefix", async () => {
    fake.seed("meetings", [{ id: MEETING, source: "in_person" }]);

    await expect(
      call(transcribeInPersonMeeting)({
        data: {
          id: MEETING,
          audioPath: `${TEST_USER}/${MEETING}.webm`,
          videoPath: `someone-else/${MEETING}.video.webm`,
        },
      }),
    ).rejects.toThrow("Invalid video path");
    expect(writeCount(fake)).toBe(0);
  });

  it("stamps both storage paths and finalizes the recording", async () => {
    fake.seed("meetings", [{ id: MEETING, source: "in_person" }]);
    finalizeInPersonMeeting.mockResolvedValue("done");

    const result = await call(transcribeInPersonMeeting)({
      data: {
        id: MEETING,
        audioPath: `${TEST_USER}/${MEETING}.webm`,
        videoPath: `${TEST_USER}/${MEETING}.video.webm`,
      },
    });

    expect(result).toStrictEqual({ status: "done" });
    expect(fake.calls.updates.map((w) => [w.table, w.payload, w.filters])).toStrictEqual([
      [
        "meetings",
        {
          audio_storage_path: `${TEST_USER}/${MEETING}.webm`,
          video_storage_path: `${TEST_USER}/${MEETING}.video.webm`,
          status: "processing",
        },
        [{ op: "eq", col: "id", value: MEETING, extra: undefined }],
      ],
    ]);
    expect(finalizeInPersonMeeting.mock.calls).toStrictEqual([[MEETING]]);
  });

  it("surfaces a failing path update without finalizing", async () => {
    fake.seed("meetings", [{ id: MEETING, source: "in_person" }]);
    fake.onUpdate("meetings", () => ({ message: "update denied" }));

    await expect(
      call(transcribeInPersonMeeting)({
        data: { id: MEETING, audioPath: `${TEST_USER}/${MEETING}.webm` },
      }),
    ).rejects.toThrow("update denied");
    expect(finalizeInPersonMeeting).not.toHaveBeenCalled();
  });
});
