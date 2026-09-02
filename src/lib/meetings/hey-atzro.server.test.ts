// Unit tests for in-meeting Q&A (src/lib/meetings/hey-atzro.server.ts).
// This answers out loud in a live meeting chat, so the contracts that
// matter are: it is grounded ONLY in the recent transcript buffer for the
// asking bot, it debounces (voice and chat wake phrases routinely fire
// within the same second), and every attempt — including a model or chat
// failure — is recorded in meeting_qa rather than lost.
//
// The wake-phrase regex itself lives in the public realtime route
// (src/routes/api/public/recall-realtime.ts), not in this module.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const { generateText, sendBotChatMessage, logError, logInfo } = vi.hoisted(() => ({
  generateText: vi.fn(async (_args: unknown) => ({ text: "" })),
  sendBotChatMessage: vi.fn<typeof import("@/lib/recall.server").sendBotChatMessage>(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("ai", () => ({ generateText }));
vi.mock("@/lib/ai-gateway", () => ({ getModel: vi.fn((id: string) => ({ id })) }));
vi.mock("@/lib/recall.server", () => ({ sendBotChatMessage }));
vi.mock("@/lib/log.server", () => ({ logError, logInfo, logAudit: vi.fn() }));

import {
  appendTranscriptSegments,
  askAtzroInMeeting,
  ensureTranscriptBuffer,
  type TranscriptSeg,
} from "./hey-atzro.server";

const BOT = "bot_abc";
const MEETING = "11111111-1111-4111-8111-111111111111";
const USER = "user-1";
const NOW = Date.parse("2026-03-01T12:00:00Z");
const NOW_ISO = "2026-03-01T12:00:00.000Z";
/** Just inside / just outside the 15-minute grounding window. */
const RECENT_T = NOW - 5 * 60 * 1000;
const STALE_T = NOW - 20 * 60 * 1000;

function seedBuffer(overrides?: {
  segments?: TranscriptSeg[] | null;
  lastTriggerAt?: string | null;
}) {
  fake.seed("meeting_transcript_buffer", [
    {
      bot_id: BOT,
      meeting_id: MEETING,
      user_id: USER,
      segments: overrides?.segments ?? [{ t: RECENT_T, s: "Ada", w: "we ship on Friday" }],
      last_trigger_at: overrides?.lastTriggerAt ?? null,
    },
  ]);
}

/** The system prompt the model was given on the nth call. */
function systemPrompt(n = 0): string {
  const args = generateText.mock.calls[n]?.[0] as {
    messages: Array<{ role: string; content: string }>;
  };
  return args.messages[0]?.content ?? "";
}

beforeEach(() => {
  fake.reset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  generateText.mockResolvedValue({ text: "  We ship on Friday.  " });
  sendBotChatMessage.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("askAtzroInMeeting", () => {
  it("does nothing for a bot with no transcript buffer", async () => {
    await askAtzroInMeeting({ botId: BOT, question: "what did we decide?", source: "voice" });

    expect(generateText).not.toHaveBeenCalled();
    expect(sendBotChatMessage).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
    expect(logInfo.mock.calls[0]).toStrictEqual(["hey_zerrow_no_buffer", { botId: BOT }]);
  });

  it("ignores a second trigger within the debounce window", async () => {
    seedBuffer({ lastTriggerAt: new Date(NOW - 3_000).toISOString() });

    await askAtzroInMeeting({ botId: BOT, question: "again?", source: "chat" });

    expect(generateText).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("answers again once the debounce window has passed", async () => {
    seedBuffer({ lastTriggerAt: new Date(NOW - 5_000).toISOString() });

    await askAtzroInMeeting({ botId: BOT, question: "again?", source: "chat" });

    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("stamps the trigger time before asking the model", async () => {
    seedBuffer();

    await askAtzroInMeeting({ botId: BOT, question: "what did we decide?", source: "voice" });

    expect(fake.calls.updates.map((w) => [w.table, w.payload, w.filters])).toStrictEqual([
      [
        "meeting_transcript_buffer",
        { last_trigger_at: NOW_ISO },
        [{ op: "eq", col: "bot_id", value: BOT, extra: undefined }],
      ],
    ]);
  });

  it("grounds the answer only in segments inside the context window", async () => {
    seedBuffer({
      segments: [
        { t: STALE_T, s: "Grace", w: "budget talk from half an hour ago" },
        { t: RECENT_T, s: "Ada", w: "we ship on Friday" },
        { t: RECENT_T, s: null, w: "unattributed line" },
      ],
    });

    await askAtzroInMeeting({ botId: BOT, question: "when do we ship?", source: "voice" });

    const prompt = systemPrompt();
    expect(prompt).toContain("Ada: we ship on Friday");
    expect(prompt).toContain("unattributed line");
    expect(prompt, "stale transcript must not be fed to the model").not.toContain("budget talk");
  });

  it("tells the model there is nothing to work from when the buffer is empty", async () => {
    seedBuffer({ segments: [] });

    await askAtzroInMeeting({ botId: BOT, question: "anything?", source: "voice" });

    expect(systemPrompt()).toContain("(no transcript captured yet)");
  });

  it("truncates a very long question before sending it to the model", async () => {
    seedBuffer();

    await askAtzroInMeeting({ botId: BOT, question: "q".repeat(900), source: "chat" });

    const args = generateText.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(args.messages[1]?.content).toHaveLength(500);
  });

  it("posts the answer to the meeting chat and records the exchange", async () => {
    seedBuffer();

    await askAtzroInMeeting({
      botId: BOT,
      question: "when do we ship?",
      source: "chat",
      asker: "Ada",
    });

    expect(sendBotChatMessage.mock.calls).toStrictEqual([[BOT, "Atzro: We ship on Friday."]]);
    expect(fake.calls.inserts.map((w) => [w.table, w.payload])).toStrictEqual([
      [
        "meeting_qa",
        {
          bot_id: BOT,
          meeting_id: MEETING,
          user_id: USER,
          trigger_source: "chat",
          asker: "Ada",
          question: "when do we ship?",
          answer: "We ship on Friday.",
          latency_ms: 0,
          error: null,
        },
      ],
    ]);
  });

  it("caps the chat reply at the length the meeting chat accepts", async () => {
    seedBuffer();
    generateText.mockResolvedValue({ text: "z".repeat(2000) });

    await askAtzroInMeeting({ botId: BOT, question: "long?", source: "voice" });

    expect(sendBotChatMessage.mock.calls[0]?.[1]).toHaveLength(1000);
    // The stored answer keeps more of it than the chat message does.
    expect((fake.calls.inserts[0]?.payload as { answer: string }).answer).toHaveLength(2000);
  });

  it("substitutes a fallback line when the model returns nothing", async () => {
    seedBuffer();
    generateText.mockResolvedValue({ text: "   " });

    await askAtzroInMeeting({ botId: BOT, question: "?", source: "voice" });

    expect(sendBotChatMessage.mock.calls[0]?.[1]).toBe(
      "Atzro: I couldn't find an answer in the transcript.",
    );
  });

  it("apologizes in chat and records the model failure instead of going silent", async () => {
    seedBuffer();
    generateText.mockRejectedValue(new Error("gateway 503"));

    await askAtzroInMeeting({ botId: BOT, question: "?", source: "voice" });

    expect(sendBotChatMessage.mock.calls[0]?.[1]).toBe(
      "Atzro: Sorry — I couldn't answer that. Try again in a moment.",
    );
    expect(fake.calls.inserts[0]?.payload).toMatchObject({ error: "gateway 503" });
    expect(logError.mock.calls[0]).toStrictEqual([
      "hey_zerrow_llm_failed",
      { botId: BOT, err: "gateway 503" },
    ]);
  });

  it("still records the exchange when the chat message cannot be delivered", async () => {
    seedBuffer();
    sendBotChatMessage.mockRejectedValue(new Error("Recall API 500"));

    await askAtzroInMeeting({ botId: BOT, question: "?", source: "voice" });

    expect(logError.mock.calls[0]).toStrictEqual([
      "hey_zerrow_send_failed",
      { botId: BOT, err: "Recall API 500" },
    ]);
    expect(fake.calls.inserts.filter((w) => w.table === "meeting_qa")).toHaveLength(1);
  });
});

describe("appendTranscriptSegments", () => {
  it("does not even read the buffer for an empty batch", async () => {
    await appendTranscriptSegments(BOT, []);

    expect(fake.calls.selects).toStrictEqual([]);
    expect(writeCount(fake)).toBe(0);
  });

  it("writes nothing when the bot has no provisioned buffer", async () => {
    await appendTranscriptSegments(BOT, [{ t: NOW, s: null, w: "hello" }]);

    expect(writeCount(fake)).toBe(0);
  });

  it("appends to the existing segments and drops anything past the window", async () => {
    seedBuffer({
      segments: [
        { t: STALE_T, s: "Grace", w: "old" },
        { t: RECENT_T, s: "Ada", w: "kept" },
      ],
    });

    await appendTranscriptSegments(BOT, [{ t: NOW, s: "Ada", w: "new" }]);

    expect(fake.calls.updates.map((w) => [w.table, w.payload, w.filters])).toStrictEqual([
      [
        "meeting_transcript_buffer",
        {
          segments: [
            { t: RECENT_T, s: "Ada", w: "kept" },
            { t: NOW, s: "Ada", w: "new" },
          ],
          updated_at: NOW_ISO,
        },
        [{ op: "eq", col: "bot_id", value: BOT, extra: undefined }],
      ],
    ]);
  });

  it("keeps only the most recent segments once the buffer is full", async () => {
    seedBuffer({
      segments: Array.from({ length: 1500 }, (_, i) => ({ t: RECENT_T, s: null, w: `w${i}` })),
    });

    await appendTranscriptSegments(BOT, [{ t: NOW, s: null, w: "newest" }]);

    const segments = (fake.calls.updates[0]?.payload as { segments: TranscriptSeg[] }).segments;
    expect(segments).toHaveLength(1500);
    expect(segments[0]?.w).toBe("w1");
    expect(segments.at(-1)?.w).toBe("newest");
  });
});

describe("ensureTranscriptBuffer", () => {
  it("returns the existing buffer without inserting a second one", async () => {
    seedBuffer();

    // (The fake does not project columns, so the returned row is matched
    // loosely; what this pins is that no second buffer is created.)
    await expect(ensureTranscriptBuffer(BOT)).resolves.toMatchObject({
      meeting_id: MEETING,
      user_id: USER,
    });
    expect(writeCount(fake)).toBe(0);
  });

  it("provisions a buffer from the bot's meeting row", async () => {
    fake.seed("meetings", [{ id: MEETING, user_id: USER, recall_bot_id: BOT }]);

    await expect(ensureTranscriptBuffer(BOT)).resolves.toStrictEqual({
      meeting_id: MEETING,
      user_id: USER,
    });
    expect(fake.calls.inserts.map((w) => [w.table, w.payload])).toStrictEqual([
      [
        "meeting_transcript_buffer",
        { bot_id: BOT, meeting_id: MEETING, user_id: USER, segments: [] },
      ],
    ]);
  });

  it("refuses to provision a buffer for a bot with no meeting row", async () => {
    await expect(ensureTranscriptBuffer(BOT)).resolves.toBeNull();
    expect(writeCount(fake)).toBe(0);
  });
});
