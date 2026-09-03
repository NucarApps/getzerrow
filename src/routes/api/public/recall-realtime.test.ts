// Contract for the Recall real-time firehose endpoint: its own token gate,
// the tolerance it has to be given for a high-volume stream (one oddly-shaped
// word must never 400 away a whole batch and the wake phrase inside it), and
// the two wake paths — spoken transcript and meeting chat.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "./__fixtures__/route-harness";
import { Route } from "./recall-realtime";

const askAtzroInMeeting = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/meetings/hey-atzro.server").askAtzroInMeeting>(),
);
const appendTranscriptSegments = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/meetings/hey-atzro.server").appendTranscriptSegments>(),
);
const ensureTranscriptBuffer = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/meetings/hey-atzro.server").ensureTranscriptBuffer>(),
);
vi.mock("@/lib/meetings/hey-atzro.server", () => ({
  askAtzroInMeeting,
  appendTranscriptSegments,
  ensureTranscriptBuffer,
}));

const POST = handler(Route, "POST");

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const TOKEN = "recall-realtime-token";
const BOT_ID = "bot-1";

async function post(
  body: unknown,
  opts: { headers?: Record<string, string>; query?: string } = {},
): Promise<Response> {
  const request = new Request(`https://atzro.test/api/public/recall-realtime${opts.query ?? ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...opts.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST({ request, params: {} });
}

/** A transcript event carrying `text` as its word stream. */
function transcript(text: string, over: Record<string, unknown> = {}) {
  return {
    event: "transcript.data",
    data: {
      bot: { id: BOT_ID },
      data: {
        words: text.split(" ").map((w) => ({ text: w })),
        participant: { name: "Dana" },
        ...over,
      },
    },
  };
}

function chat(text: string, over: Record<string, unknown> = {}) {
  return {
    event: "participant_events.chat_message",
    data: {
      bot: { id: BOT_ID },
      data: { text, sender: { name: "Dana", is_host: true }, ...over },
    },
  };
}

const authed = { headers: { "x-recall-token": TOKEN } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("RECALL_REALTIME_TOKEN", TOKEN);
  ensureTranscriptBuffer.mockResolvedValue({ meeting_id: "meeting-1", user_id: "user-1" });
  appendTranscriptSegments.mockResolvedValue();
  askAtzroInMeeting.mockResolvedValue(undefined as Awaited<ReturnType<typeof askAtzroInMeeting>>);
});

describe("token gate", () => {
  it("accepts the token in the x-recall-token header", async () => {
    const res = await post(transcript("hello there"), authed);

    expect(res.status).toBe(200);
    expect(ensureTranscriptBuffer).toHaveBeenCalledWith(BOT_ID);
  });

  it("still accepts the legacy ?t= query param Recall was configured with", async () => {
    const res = await post(transcript("hello there"), { query: `?t=${TOKEN}` });

    expect(res.status).toBe(200);
  });

  it("prefers the header over the query param", async () => {
    const res = await post(transcript("hello there"), {
      headers: { "x-recall-token": "wrong" },
      query: `?t=${TOKEN}`,
    });

    expect(res.status).toBe(401);
  });

  it.each([
    ["no token at all", {}],
    ["a wrong token", { "x-recall-token": "not-the-token" }],
    ["a prefix of the token", { "x-recall-token": TOKEN.slice(0, -1) }],
    ["the token with trailing junk", { "x-recall-token": `${TOKEN}x` }],
  ])("rejects %s", async (_name, headers) => {
    const res = await post(transcript("hello there"), { headers });

    expect(res.status).toBe(401);
    expect(ensureTranscriptBuffer).not.toHaveBeenCalled();
  });

  it("fails closed when RECALL_REALTIME_TOKEN is not configured", async () => {
    vi.stubEnv("RECALL_REALTIME_TOKEN", undefined);

    const res = await post(transcript("hello there"), authed);

    expect(res.status).toBe(401);
  });

  it("ignores surrounding whitespace on both sides of the comparison", async () => {
    vi.stubEnv("RECALL_REALTIME_TOKEN", `  ${TOKEN}  `);

    const res = await post(transcript("hello there"), {
      headers: { "x-recall-token": ` ${TOKEN} ` },
    });

    expect(res.status).toBe(200);
  });
});

describe("payload validation", () => {
  it("rejects a body that is not JSON", async () => {
    const res = await post("not json", authed);

    expect(res.status).toBe(400);
  });

  it("rejects a payload whose shape does not match the schema", async () => {
    const res = await post({ event: 42 }, authed);

    expect(res.status).toBe(400);
  });

  it("acks an event with no bot id without touching the buffer", async () => {
    const res = await post({ event: "transcript.data", data: {} }, authed);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(ensureTranscriptBuffer).not.toHaveBeenCalled();
  });

  it("acks when the bot has no meeting buffer to write into", async () => {
    ensureTranscriptBuffer.mockResolvedValue(null);

    const res = await post(transcript("hey atzro what is next"), authed);

    expect(res.status).toBe(200);
    expect(appendTranscriptSegments).not.toHaveBeenCalled();
    expect(askAtzroInMeeting).not.toHaveBeenCalled();
  });

  it("tolerates an unknown key rather than dropping the batch it rides on", async () => {
    const res = await post(
      {
        event: "transcript.data",
        data: {
          bot: { id: BOT_ID },
          data: {
            words: [{ text: "hey", start_timestamp: 1.25 }, { text: "there" }],
            participant: { name: "Dana" },
          },
        },
      },
      authed,
    );

    expect(res.status).toBe(200);
    expect(appendTranscriptSegments).toHaveBeenCalledWith(BOT_ID, [
      { t: NOW, s: "Dana", w: "hey there" },
    ]);
  });
});

describe("spoken transcript", () => {
  it("buffers the joined words with the speaker and the arrival time", async () => {
    await post(transcript("the  quarterly numbers look fine"), authed);

    expect(appendTranscriptSegments).toHaveBeenCalledWith(BOT_ID, [
      { t: NOW, s: "Dana", w: "the quarterly numbers look fine" },
    ]);
    expect(askAtzroInMeeting).not.toHaveBeenCalled();
  });

  it("buffers with a null speaker when the participant is unnamed", async () => {
    await post(transcript("hello there", { participant: null }), authed);

    expect(appendTranscriptSegments).toHaveBeenCalledWith(BOT_ID, [
      { t: NOW, s: null, w: "hello there" },
    ]);
  });

  it("skips an empty word stream entirely", async () => {
    const res = await post(
      { event: "transcript.data", data: { bot: { id: BOT_ID }, data: { words: [] } } },
      authed,
    );

    expect(res.status).toBe(200);
    expect(appendTranscriptSegments).not.toHaveBeenCalled();
  });

  it.each([
    ["hey atzro what is our runway", "what is our runway"],
    ["@atzro summarise the last hour", "summarise the last hour"],
    ["so, hey zerrow when do we ship", "when do we ship"],
    ["ok @zerrow: what did Dana say", "what did Dana say"],
  ])("answers the wake phrase in %j", async (said, question) => {
    await post(transcript(said), authed);

    expect(askAtzroInMeeting).toHaveBeenCalledWith({
      botId: BOT_ID,
      question,
      source: "voice",
      asker: "Dana",
    });
  });

  it("ignores a wake phrase with fewer than three words after it", async () => {
    await post(transcript("hey atzro hello there"), authed);

    expect(askAtzroInMeeting).not.toHaveBeenCalled();
    // The words are still buffered — only the answer is suppressed.
    expect(appendTranscriptSegments).toHaveBeenCalledTimes(1);
  });

  it("ignores a wake word embedded mid-token", async () => {
    await post(transcript("theyatzro said something odd"), authed);

    expect(askAtzroInMeeting).not.toHaveBeenCalled();
  });

  it("caps the question at 500 characters", async () => {
    await post(transcript(`hey atzro ${"word ".repeat(200)}`), authed);

    const question = askAtzroInMeeting.mock.calls[0]?.[0]?.question ?? "";
    expect(question).toHaveLength(500);
  });
});

describe("meeting chat", () => {
  it("answers a wake phrase typed in chat", async () => {
    const res = await post(chat("@atzro what did we decide"), authed);

    expect(res.status).toBe(200);
    expect(askAtzroInMeeting).toHaveBeenCalledWith({
      botId: BOT_ID,
      question: "what did we decide",
      source: "chat",
      asker: "Dana",
    });
    // Chat is not transcript: nothing is added to the spoken buffer.
    expect(appendTranscriptSegments).not.toHaveBeenCalled();
  });

  it("never answers its own chat messages", async () => {
    await post(chat("@atzro what did we decide", { is_from_bot: true }), authed);

    expect(askAtzroInMeeting).not.toHaveBeenCalled();
  });

  it("ignores a chat message with no wake phrase", async () => {
    await post(chat("sounds good to me"), authed);

    expect(askAtzroInMeeting).not.toHaveBeenCalled();
  });

  it("ignores an empty chat message", async () => {
    await post(chat("   "), authed);

    expect(askAtzroInMeeting).not.toHaveBeenCalled();
  });
});

describe("resilience", () => {
  it("acks even when answering in the meeting throws", async () => {
    askAtzroInMeeting.mockRejectedValue(new Error("chat send failed"));

    const res = await post(transcript("hey atzro what is our runway"), authed);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("acks an event type it does not handle", async () => {
    const res = await post({ event: "bot.status_change", data: { bot: { id: BOT_ID } } }, authed);

    expect(res.status).toBe(200);
    expect(appendTranscriptSegments).not.toHaveBeenCalled();
    expect(askAtzroInMeeting).not.toHaveBeenCalled();
  });
});
