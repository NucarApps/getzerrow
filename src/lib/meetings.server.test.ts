// Characterization tests for the untested meetings core in
// src/lib/meetings.server.ts: the Recall status → meeting_status mapping the
// webhook route relies on, syncMeetingFromRecall's transitions (recording,
// done finalize, blocked-participant abort, failure messages) and its error
// paths (a Recall API failure must not touch the meeting row), the
// participant→contact linker, and the playback URL hot path. Recall and the
// service-role Supabase client are mocked at module level — no live HTTP.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/f" } }),
        download: async () => ({ data: null, error: null }),
      }),
    },
    auth: {
      admin: {
        getUserById: async () => ({
          data: { user: { email: "owner@example.com", user_metadata: { full_name: "Owner" } } },
        }),
      },
    },
  },
}));

vi.mock("./recall.server", () => ({
  getBot: vi.fn(),
  getTranscript: vi.fn(),
  extractRecordingUrl: vi.fn(),
  extractParticipantEmails: vi.fn(),
  latestStatusCode: vi.fn(),
  leaveBot: vi.fn(),
  summarizeTranscript: vi.fn(),
}));
vi.mock("./meetings-autojoin.server", () => ({ findBlockedEmailForUser: vi.fn() }));
vi.mock("./tasks/extract.server", () => ({ extractTasksFromMeetingTranscript: vi.fn() }));
vi.mock("./log.server", () => ({ logError: vi.fn() }));
vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("./ai-gateway", () => ({ getModel: vi.fn() }));

import {
  mapStatus,
  syncMeetingFromRecall,
  linkParticipantsToContacts,
  resolvePlayableRecordingUrl,
  refreshMeetingRecording,
} from "./meetings.server";
import {
  getBot,
  getTranscript,
  extractRecordingUrl,
  extractParticipantEmails,
  latestStatusCode,
  leaveBot,
  summarizeTranscript,
  type RecallBot,
  type TranscriptSegment,
} from "./recall.server";
import { findBlockedEmailForUser } from "./meetings-autojoin.server";
import { extractTasksFromMeetingTranscript } from "./tasks/extract.server";
import { generateText } from "ai";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const NOW_ISO = "2026-09-01T12:00:00.000Z";

const baseMeeting = {
  id: "m1",
  user_id: "u1",
  recall_bot_id: "bot-1",
  status: "joining",
  title: "Weekly sync",
};

const SEGMENTS: TranscriptSegment[] = [
  { speaker: "Alice", text: "We agreed to ship on Friday.", start: 0 },
  { speaker: "Bob", text: "I will write the release notes.", start: 12 },
];

const meetingUpdates = () => fake.calls.updates.filter((u) => u.table === "meetings");

/** Re-arm every module-level mock (the global setup restores them after each test). */
function armMocks() {
  vi.mocked(getBot).mockResolvedValue({ id: "bot-1" } as RecallBot);
  vi.mocked(getTranscript).mockResolvedValue([]);
  vi.mocked(extractRecordingUrl).mockReturnValue(null);
  vi.mocked(extractParticipantEmails).mockReturnValue([]);
  vi.mocked(latestStatusCode).mockReturnValue(null);
  vi.mocked(leaveBot).mockResolvedValue(undefined);
  vi.mocked(summarizeTranscript).mockReturnValue("Key moments\n• Alice: We agreed to ship.");
  vi.mocked(findBlockedEmailForUser).mockResolvedValue(null);
  vi.mocked(extractTasksFromMeetingTranscript).mockResolvedValue(0);
}

beforeEach(() => {
  // The global setup's restoreAllMocks doesn't clear vi.mock-factory fns.
  vi.clearAllMocks();
  // Empty key ⇒ AI title/breakdown generation short-circuits to null, so the
  // extractive digest fallback is what lands unless a test opts in.
  vi.stubEnv("LOVABLE_API_KEY", "");
  fake.reset();
  fake.seed("meetings", [{ ...baseMeeting, transcript: null, summary: null }]);
  armMocks();
});

describe("mapStatus", () => {
  it("maps every Recall status code family onto the meeting_status enum", () => {
    expect(mapStatus(null)).toBe("scheduled");
    expect(mapStatus("ready")).toBe("scheduled");
    for (const c of ["joining_call", "in_waiting_room", "in_call_not_recording"])
      expect(mapStatus(c)).toBe("joining");
    for (const c of ["in_call_recording", "recording"]) expect(mapStatus(c)).toBe("recording");
    for (const c of ["done", "recording_done", "call_ended"]) expect(mapStatus(c)).toBe("done");
    for (const c of ["fatal", "call_not_started", "timeout"]) expect(mapStatus(c)).toBe("failed");
  });
});

describe("syncMeetingFromRecall", () => {
  it("leaves the meeting row untouched when the Recall lookup fails", async () => {
    // No bot id: nothing to sync, Recall never called.
    expect(await syncMeetingFromRecall({ ...baseMeeting, recall_bot_id: null })).toBe("joining");
    expect(getBot).not.toHaveBeenCalled();

    // Recall API failure: status echoed back, zero writes — the row is not
    // corrupted by a transient outage.
    vi.mocked(getBot).mockRejectedValue(new Error("recall 500"));
    expect(await syncMeetingFromRecall(baseMeeting)).toBe("joining");
    expect(fake.calls.updates).toHaveLength(0);
    expect(fake.calls.inserts).toHaveLength(0);
  });

  it("moves to recording and stores the recording url without transcript work", async () => {
    vi.mocked(latestStatusCode).mockReturnValue("in_call_recording");
    vi.mocked(extractRecordingUrl).mockReturnValue("https://rec.example/video.mp4");

    const status = await syncMeetingFromRecall(baseMeeting);

    expect(status).toBe("recording");
    expect(meetingUpdates()).toHaveLength(1);
    expect(meetingUpdates()[0]!.payload).toEqual({
      status: "recording",
      recording_url: "https://rec.example/video.mp4",
    });
    expect(meetingUpdates()[0]!.filters).toEqual([{ op: "eq", col: "id", value: "m1" }]);
    expect(getTranscript).not.toHaveBeenCalled();
    expect(extractTasksFromMeetingTranscript).not.toHaveBeenCalled();
  });

  it("finalizes a done bot: transcript, summary, ended_at, contact links, task extraction", async () => {
    vi.useFakeTimers({ now: NOW });
    vi.mocked(latestStatusCode).mockReturnValue("done");
    vi.mocked(extractRecordingUrl).mockReturnValue("https://rec.example/final.mp4");
    vi.mocked(getTranscript).mockResolvedValue(SEGMENTS);
    // Seed the row as the DB would look mid-finalize so the task-extraction
    // re-read finds a transcript (the fake's writes don't mutate seeds).
    fake.reset();
    fake.seed("meetings", [{ ...baseMeeting, transcript: SEGMENTS, summary: null }]);
    fake.seed("meeting_participants", [
      { id: "p1", meeting_id: "m1", email: "Bob@Acme.com", contact_id: null },
    ]);
    fake.seed("contacts", [{ id: "c1", user_id: "u1", email: "bob@acme.com" }]);
    armMocks();
    vi.mocked(latestStatusCode).mockReturnValue("done");
    vi.mocked(extractRecordingUrl).mockReturnValue("https://rec.example/final.mp4");
    vi.mocked(getTranscript).mockResolvedValue(SEGMENTS);

    const status = await syncMeetingFromRecall(baseMeeting);

    expect(status).toBe("done");
    const saved = meetingUpdates()[0]!.payload as Record<string, unknown>;
    expect(saved).toEqual({
      status: "done",
      recording_url: "https://rec.example/final.mp4",
      ended_at: NOW_ISO,
      transcript: SEGMENTS,
      summary: "Key moments\n• Alice: We agreed to ship.",
    });
    // A real user title is never overwritten by an auto-generated one.
    expect(saved).not.toHaveProperty("title");

    // Participant matched to the contact case-insensitively.
    const partUpdate = fake.calls.updates.find((u) => u.table === "meeting_participants");
    expect(partUpdate?.payload).toEqual({ contact_id: "c1" });
    expect(partUpdate?.filters).toEqual([{ op: "eq", col: "id", value: "p1" }]);

    expect(extractTasksFromMeetingTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", meetingId: "m1" }),
    );
  });

  it("auto-titles an untitled meeting from the AI breakdown, cleaning quotes/punctuation", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test-key");
    vi.mocked(latestStatusCode).mockReturnValue("done");
    vi.mocked(getTranscript).mockResolvedValue(SEGMENTS);
    (generateText as unknown as Mock).mockImplementation(
      async (opts: { messages: Array<{ role: string; content: string }> }) =>
        opts.messages[0]!.content.includes("meeting titles")
          ? { text: ' "Quarterly roadmap review." ' }
          : { text: "## Overview\nWe discussed the roadmap and shipping dates." },
    );

    await syncMeetingFromRecall({ ...baseMeeting, title: null });

    const saved = meetingUpdates()[0]!.payload as Record<string, unknown>;
    // The AI breakdown wins over the extractive digest…
    expect(String(saved.summary)).toMatch(/^## Overview/);
    // …and the generated title is trimmed of quotes and trailing periods.
    expect(saved.title).toBe("Quarterly roadmap review");
  });

  it("pulls the bot out and fails the meeting when a blocked person is present", async () => {
    vi.useFakeTimers({ now: NOW });
    vi.mocked(latestStatusCode).mockReturnValue("in_call_recording");
    vi.mocked(extractParticipantEmails).mockReturnValue(["spy@blocked.com"]);
    vi.mocked(findBlockedEmailForUser).mockResolvedValue("spy@blocked.com");

    const status = await syncMeetingFromRecall(baseMeeting);

    expect(status).toBe("failed");
    expect(leaveBot).toHaveBeenCalledWith("bot-1");
    expect(meetingUpdates()).toHaveLength(1);
    expect(meetingUpdates()[0]!.payload).toEqual({
      status: "failed",
      error: "Recording stopped — a blocked person was in the meeting.",
      ended_at: NOW_ISO,
    });
    // The discarded recording never gets transcript/summary work.
    expect(getTranscript).not.toHaveBeenCalled();
  });

  it("records the failure message from Recall's status change on a failed bot", async () => {
    vi.mocked(latestStatusCode).mockReturnValue("fatal");
    vi.mocked(getBot).mockResolvedValue({
      id: "bot-1",
      status_changes: [
        { code: "joining_call", created_at: "2026-09-01T11:00:00Z" },
        { code: "fatal", created_at: "2026-09-01T11:01:00Z", message: "Meeting locked" },
      ],
    } as RecallBot);

    const status = await syncMeetingFromRecall(baseMeeting);

    expect(status).toBe("failed");
    expect(meetingUpdates()[0]!.payload).toEqual({ status: "failed", error: "Meeting locked" });
  });

  it("still persists the done status when the transcript fetch fails (characterization)", async () => {
    vi.useFakeTimers({ now: NOW });
    vi.mocked(latestStatusCode).mockReturnValue("done");
    vi.mocked(getTranscript).mockRejectedValue(new Error("transcript file 503"));

    const status = await syncMeetingFromRecall(baseMeeting);

    // The row moves to done with no transcript/summary; the refresh/backfill
    // path (refreshMeetingRecording) is what recovers them later.
    expect(status).toBe("done");
    const saved = meetingUpdates()[0]!.payload as Record<string, unknown>;
    expect(saved).toEqual({ status: "done", ended_at: NOW_ISO });
  });
});

describe("linkParticipantsToContacts", () => {
  it("links only unlinked participants with a matching contact, case-insensitively", async () => {
    fake.seed("meeting_participants", [
      { id: "p1", meeting_id: "m1", email: "already@acme.com", contact_id: "c0" },
      { id: "p2", meeting_id: "m1", email: "nomatch@other.com", contact_id: null },
      { id: "p3", meeting_id: "m1", email: "Match@Acme.com", contact_id: null },
    ]);
    fake.seed("contacts", [{ id: "c1", user_id: "u1", email: "match@acme.com" }]);

    await linkParticipantsToContacts("m1", "u1");

    expect(fake.calls.updates).toHaveLength(1);
    expect(fake.calls.updates[0]).toMatchObject({
      table: "meeting_participants",
      payload: { contact_id: "c1" },
      filters: [{ op: "eq", col: "id", value: "p3" }],
    });
  });
});

describe("resolvePlayableRecordingUrl", () => {
  it("returns the stored url on the hot path without calling Recall", async () => {
    fake.seed("meetings", [
      {
        id: "m1",
        recall_bot_id: "bot-1",
        recording_url: "https://stored.example/v.mp4",
        audio_storage_path: null,
        video_storage_path: null,
      },
    ]);

    const res = await resolvePlayableRecordingUrl("m1");

    expect(res).toEqual({
      url: "https://stored.example/v.mp4",
      recallBotId: "bot-1",
      contentType: "video/mp4",
      filename: "recording-m1.mp4",
    });
    expect(getBot).not.toHaveBeenCalled();
    expect(fake.calls.updates).toHaveLength(0);
  });

  it("mints and persists a fresh Recall url only when none is stored", async () => {
    fake.seed("meetings", [
      {
        id: "m1",
        recall_bot_id: "bot-1",
        recording_url: null,
        audio_storage_path: null,
        video_storage_path: null,
      },
    ]);
    vi.mocked(extractRecordingUrl).mockReturnValue("https://fresh.example/v.mp4");

    const res = await resolvePlayableRecordingUrl("m1");

    expect(res.url).toBe("https://fresh.example/v.mp4");
    expect(getBot).toHaveBeenCalledWith("bot-1");
    expect(meetingUpdates()[0]).toMatchObject({
      payload: { recording_url: "https://fresh.example/v.mp4" },
      filters: [{ op: "eq", col: "id", value: "m1" }],
    });
  });
});

describe("refreshMeetingRecording", () => {
  it("returns the stored state and writes nothing when Recall is down", async () => {
    fake.seed("meetings", [
      {
        id: "m1",
        user_id: "u1",
        recall_bot_id: "bot-1",
        recording_url: "https://stored.example/v.mp4",
        transcript: SEGMENTS,
        summary: "old digest",
      },
    ]);
    vi.mocked(getBot).mockRejectedValue(new Error("recall 502"));

    const res = await refreshMeetingRecording("m1");

    expect(res).toEqual({
      recordingUrl: "https://stored.example/v.mp4",
      hasRecording: true,
      hasTranscript: true,
      hasSummary: true,
    });
    expect(fake.calls.updates).toHaveLength(0);
  });

  it("backfills a missing transcript and summary without touching the status", async () => {
    fake.seed("meetings", [
      {
        id: "m1",
        user_id: "u1",
        recall_bot_id: "bot-1",
        recording_url: null,
        transcript: null,
        summary: null,
      },
    ]);
    vi.mocked(extractRecordingUrl).mockReturnValue("https://fresh.example/v.mp4");
    vi.mocked(getTranscript).mockResolvedValue(SEGMENTS);

    const res = await refreshMeetingRecording("m1");

    expect(res).toEqual({
      recordingUrl: "https://fresh.example/v.mp4",
      hasRecording: true,
      hasTranscript: true,
      hasSummary: true,
    });
    const saved = meetingUpdates()[0]!.payload as Record<string, unknown>;
    expect(saved).toEqual({
      recording_url: "https://fresh.example/v.mp4",
      transcript: SEGMENTS,
      summary: "Key moments\n• Alice: We agreed to ship.",
    });
    expect(saved).not.toHaveProperty("status");
  });
});
