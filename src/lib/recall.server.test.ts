// Unit tests for the Recall.ai REST client (src/lib/recall.server.ts).
// Everything here is pure fetch-stubbing: the contracts are the request
// bodies we send (a wrong `automatic_leave` shape is silently rejected by
// Recall) and the error taxonomy — which failures are swallowed as
// "already gone" and which must propagate to the caller.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createBot,
  detectPlatform,
  extractParticipantEmails,
  extractRecordingUrl,
  extractTranscriptUrl,
  getBot,
  getTranscript,
  latestStatusCode,
  leaveBot,
  RecallApiError,
  sendBotChatMessage,
  summarizeTranscript,
  type RecallBot,
} from "./recall.server";

const fetchMock = vi.fn<typeof fetch>();

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
function fail(status: number, body = "boom"): Response {
  return new Response(body, { status });
}

/** The single request the stub saw, as [url, method, parsed body]. */
function lastRequest(): { url: string; method: string; headers: Headers; body: unknown } {
  const call = fetchMock.mock.calls.at(-1);
  const init = call?.[1] as RequestInit;
  return {
    url: String(call?.[0]),
    method: String(init.method),
    headers: new Headers(init.headers),
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RECALL_API_KEY", "test-key");
  vi.stubEnv("RECALL_REGION", undefined);
  vi.stubEnv("RECALL_REALTIME_TOKEN", undefined);
  fetchMock.mockResolvedValue(ok({ id: "bot_1" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectPlatform", () => {
  it("labels each supported platform and nothing else", () => {
    expect([
      detectPlatform("https://ACME.ZOOM.US/j/123"),
      detectPlatform("https://meet.google.com/abc-defg-hij"),
      detectPlatform("https://teams.microsoft.com/l/meetup-join/x"),
      detectPlatform("https://teams.live.com/meet/x"),
      detectPlatform("https://acme.webex.com/meet/x"),
      detectPlatform("https://whereby.com/acme"),
    ]).toStrictEqual(["zoom", "google_meet", "microsoft_teams", "microsoft_teams", "webex", null]);
  });
});

describe("createBot", () => {
  it("refuses to call Recall at all when the API key is unset", async () => {
    vi.stubEnv("RECALL_API_KEY", undefined);

    await expect(createBot({ meetingUrl: "https://acme.zoom.us/j/1" })).rejects.toThrow(
      "RECALL_API_KEY is not configured",
    );
  });

  it("posts the default body to the configured region with the token header", async () => {
    vi.stubEnv("RECALL_REGION", "eu-central-1");

    await createBot({ meetingUrl: "https://acme.zoom.us/j/1" });

    const req = lastRequest();
    expect(req.url).toBe("https://eu-central-1.recall.ai/api/v1/bot");
    expect(req.method).toBe("POST");
    expect(req.headers.get("Authorization")).toBe("Token test-key");
    expect(req.body).toStrictEqual({
      meeting_url: "https://acme.zoom.us/j/1",
      bot_name: "Atzro Notetaker",
      recording_config: { transcript: { provider: { meeting_captions: {} } } },
    });
  });

  it("builds the chat, image, join-at and automatic-leave sections from the config", async () => {
    await createBot({
      meetingUrl: "https://acme.zoom.us/j/1",
      botName: "Scribe",
      joinAt: "2026-03-01T13:00:00Z",
      chatMessage: "  recording started  ",
      chatResendOnJoin: true,
      imageB64: "AAAA",
      everyoneLeftTimeoutSec: 300.4,
      inCallNotRecordingTimeoutSec: 299.6,
    });

    expect(lastRequest().body).toStrictEqual({
      meeting_url: "https://acme.zoom.us/j/1",
      bot_name: "Scribe",
      recording_config: { transcript: { provider: { meeting_captions: {} } } },
      join_at: "2026-03-01T13:00:00Z",
      chat: {
        on_bot_join: { send_to: "everyone", message: "recording started" },
        on_participant_join: { exclude_host: false, message: "recording started" },
      },
      automatic_video_output: {
        in_call_recording: { kind: "jpeg", b64_data: "AAAA" },
        in_call_not_recording: { kind: "jpeg", b64_data: "AAAA" },
      },
      automatic_leave: {
        everyone_left_timeout: { timeout: 300, activate_after: 1 },
        in_call_not_recording_timeout: 300,
      },
    });
  });

  it("omits automatic_leave entirely when both timeouts are null", async () => {
    await createBot({
      meetingUrl: "https://acme.zoom.us/j/1",
      everyoneLeftTimeoutSec: null,
      inCallNotRecordingTimeoutSec: null,
    });

    expect(lastRequest().body).not.toHaveProperty("automatic_leave");
  });

  it("subscribes to realtime endpoints only when the token is configured", async () => {
    vi.stubEnv("RECALL_REALTIME_TOKEN", "tok en/+");

    await createBot({ meetingUrl: "https://acme.zoom.us/j/1" });

    const body = lastRequest().body as {
      recording_config: { realtime_endpoints: Array<{ url: string; events: string[] }> };
    };
    expect(body.recording_config.realtime_endpoints).toStrictEqual([
      {
        type: "webhook",
        url: "https://getzerrow.com/api/public/recall-realtime?t=tok%20en%2F%2B",
        events: ["transcript.data", "participant_events.chat_message"],
      },
    ]);
  });

  it("raises a RecallApiError carrying the HTTP status on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(fail(422, "invalid meeting url"));

    const err = await createBot({ meetingUrl: "https://acme.zoom.us/j/1" }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(RecallApiError);
    expect((err as RecallApiError).status).toBe(422);
    expect((err as RecallApiError).message).toBe("Recall API 422 on /bot: invalid meeting url");
  });
});

describe("leaveBot", () => {
  it("swallows 400 and 404 because the bot is already gone", async () => {
    fetchMock.mockResolvedValueOnce(fail(400)).mockResolvedValueOnce(fail(404));

    await expect(leaveBot("bot_1")).resolves.toBeUndefined();
    await expect(leaveBot("bot_1")).resolves.toBeUndefined();
  });

  it("propagates a server-side failure so the caller can log it", async () => {
    fetchMock.mockResolvedValue(fail(503, "unavailable"));

    await expect(leaveBot("bot_1")).rejects.toThrow(
      "Recall API 503 on /bot/bot_1/leave_call: unavailable",
    );
  });
});

describe("sendBotChatMessage", () => {
  it("truncates to Recall's 4096-character chat limit", async () => {
    await sendBotChatMessage("bot_1", "x".repeat(5000));

    const req = lastRequest();
    expect(req.url).toBe("https://us-west-2.recall.ai/api/v1/bot/bot_1/send_chat_message");
    expect(req.body).toStrictEqual({ to: "everyone", message: "x".repeat(4096) });
  });

  it("swallows the platform refusals (400/403/404) but not a 500", async () => {
    fetchMock.mockResolvedValue(fail(403, "host-only chat"));
    await expect(sendBotChatMessage("bot_1", "hi")).resolves.toBeUndefined();

    fetchMock.mockResolvedValue(fail(500, "oops"));
    await expect(sendBotChatMessage("bot_1", "hi")).rejects.toThrow("Recall API 500");
  });
});

describe("getBot", () => {
  it("parses an empty body as an empty object rather than throwing", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));

    await expect(getBot("bot_1")).resolves.toStrictEqual({});
  });
});

describe("getTranscript", () => {
  const botWithTranscript: RecallBot = {
    id: "bot_1",
    recordings: [
      {
        id: "rec_1",
        media_shortcuts: { transcript: { data: { download_url: "https://s3/t.json" } } },
      },
    ],
  };

  it("returns nothing and makes no request when the transcript is not ready", async () => {
    await expect(getTranscript({ id: "bot_1" })).resolves.toStrictEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("joins words into speaker segments, preferring participant name over the legacy field", async () => {
    fetchMock.mockResolvedValue(
      ok([
        {
          participant: { name: "Ada" },
          speaker: "legacy",
          words: [
            { text: "Hello", start_timestamp: { relative: 1.5 } },
            { text: "  there ", start_timestamp: { relative: 2 } },
          ],
        },
        { speaker: "Grace", words: [{ text: "Hi", start_timestamp: 4 }] },
        { speaker: "Nobody", words: [{ text: "   " }] },
      ]),
    );

    await expect(getTranscript(botWithTranscript)).resolves.toStrictEqual([
      { speaker: "Ada", text: "Hello there", start: 1.5 },
      { speaker: "Grace", text: "Hi", start: 4 },
    ]);
  });

  it("returns nothing when the download fails or the payload is not a list", async () => {
    fetchMock.mockResolvedValue(fail(403));
    await expect(getTranscript(botWithTranscript)).resolves.toStrictEqual([]);

    fetchMock.mockRejectedValue(new Error("network"));
    await expect(getTranscript(botWithTranscript)).resolves.toStrictEqual([]);

    fetchMock.mockResolvedValue(ok({ not: "an array" }));
    await expect(getTranscript(botWithTranscript)).resolves.toStrictEqual([]);
  });
});

describe("bot field extractors", () => {
  it("prefers the media shortcut over the legacy video_url", () => {
    const bot: RecallBot = {
      id: "b",
      recordings: [
        {
          id: "r",
          media_shortcuts: { video_mixed: { data: { download_url: "https://s3/new.mp4" } } },
        },
      ],
      video_url: "https://legacy/old.mp4",
    };
    expect(extractRecordingUrl(bot)).toBe("https://s3/new.mp4");
    expect(extractRecordingUrl({ id: "b", video_url: "https://legacy/old.mp4" })).toBe(
      "https://legacy/old.mp4",
    );
    expect(extractRecordingUrl({ id: "b" })).toBeNull();
    expect(extractTranscriptUrl({ id: "b" })).toBeNull();
  });

  it("reads the latest status code and lowercases participant emails", () => {
    expect(
      latestStatusCode({
        id: "b",
        status_changes: [
          { code: "joining", created_at: "1" },
          { code: "done", created_at: "2" },
        ],
      }),
    ).toBe("done");
    expect(latestStatusCode({ id: "b" })).toBeNull();
    expect(
      extractParticipantEmails({
        id: "b",
        meeting_participants: [
          { name: "Ada", email: "Ada@Acme.com" },
          { name: "Grace", email: null, extra_data: { email: "GRACE@acme.com" } },
          { name: "Guest", email: "not-an-address" },
          { name: "Anon" },
        ],
      }),
    ).toStrictEqual(["ada@acme.com", "grace@acme.com"]);
  });
});

describe("summarizeTranscript", () => {
  it("returns nothing for an empty transcript", () => {
    expect(summarizeTranscript([])).toBeNull();
  });

  it("keeps the longest substantive segments in transcript order", () => {
    const seg = (start: number, words: number, speaker: string | null) => ({
      speaker,
      text: Array.from({ length: words }, (_, i) => `w${start}${i}`).join(" "),
      start,
    });

    const summary = summarizeTranscript([seg(3, 10, "Ada"), seg(1, 20, "Grace"), seg(2, 2, null)]);

    expect(summary?.split("\n")).toStrictEqual([
      "Key moments",
      `• Grace: ${seg(1, 20, null).text}`,
      `• Ada: ${seg(3, 10, null).text}`,
    ]);
  });

  it("falls back to the first segments when nothing is substantive, truncating long text", () => {
    const long = "a".repeat(400);
    const summary = summarizeTranscript([{ speaker: null, text: long, start: 0 }]);

    expect(summary).toBe(`Key moments\n• ${"a".repeat(217)}…`);
  });
});
