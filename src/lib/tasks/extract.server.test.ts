// Unit tests for AI task extraction (src/lib/tasks/extract.server.ts).
// This runs on the meeting-completion path where nothing is waiting to
// handle a rejection, so the governing contract is: it returns a count and
// NEVER throws — not on malformed model output, not on a model error, not
// on a failing insert. The claim row is what makes it idempotent, so it
// must be taken before the model is called.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const { generateText, getModel, logError, logInfo } = vi.hoisted(() => ({
  generateText: vi.fn(async (_args: unknown) => ({ text: "" })),
  getModel: vi.fn((id: string) => ({ id })),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("ai", () => ({ generateText }));
vi.mock("@/lib/ai-gateway", () => ({ getModel }));
vi.mock("@/lib/log.server", () => ({ logError, logInfo, logAudit: vi.fn() }));

import { extractTasksFromMeetingTranscript } from "./extract.server";

const USER = "user-1";
const MEETING = "11111111-1111-4111-8111-111111111111";

function input(overrides?: { transcriptText?: string; userDisplayNames?: string[] }) {
  return {
    userId: USER,
    meetingId: MEETING,
    transcriptText: "Ada: I'll send the contract by Friday.",
    userDisplayNames: ["Ada Lovelace", "ada@acme.com"],
    ...overrides,
  };
}

/** The model's reply, as the extractor's lenient parser will see it. */
function reply(body: unknown) {
  return { text: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\`` };
}

beforeEach(() => {
  fake.reset();
  generateText.mockResolvedValue({ text: "" });
});

describe("extractTasksFromMeetingTranscript", () => {
  it("does nothing for a blank transcript — no claim, no model call", async () => {
    await expect(
      extractTasksFromMeetingTranscript(input({ transcriptText: "   \n  " })),
    ).resolves.toBe(0);
    expect(writeCount(fake)).toBe(0);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("claims the source before calling the model, so a re-run is a no-op", async () => {
    fake.onInsert("task_extraction_runs", () => ({
      message: 'duplicate key value violates unique constraint "task_extraction_runs_pkey"',
      code: "23505",
    }));

    await expect(extractTasksFromMeetingTranscript(input())).resolves.toBe(0);
    expect(fake.calls.inserts.map((w) => [w.table, w.payload])).toStrictEqual([
      ["task_extraction_runs", { user_id: USER, source_type: "meeting", source_id: MEETING }],
    ]);
    expect(
      generateText,
      "a claimed source must not be sent to the model again",
    ).not.toHaveBeenCalled();
  });

  it("names the user in the system prompt and caps the transcript sent to the model", async () => {
    await extractTasksFromMeetingTranscript(
      input({ transcriptText: "x".repeat(20_000), userDisplayNames: ["Ada", "", "ada@acme.com"] }),
    );

    const messages = (
      generateText.mock.calls[0]?.[0] as {
        messages: Array<{ role: string; content: string }>;
      }
    ).messages;
    expect(messages[0]?.content).toContain("Only extract tasks that Ada, ada@acme.com personally");
    expect(messages[1]?.content).toHaveLength(12_000);
  });

  it("inserts one row per extracted task, stamped with the user and meeting", async () => {
    generateText.mockResolvedValue(
      reply({
        tasks: [
          { title: "Send the contract", notes: "by Friday", snippet: "I'll send the contract" },
          { title: "Book the venue" },
        ],
      }),
    );

    await expect(extractTasksFromMeetingTranscript(input())).resolves.toBe(2);

    expect(
      fake.calls.inserts.filter((w) => w.table === "tasks").map((w) => w.payload),
    ).toStrictEqual([
      [
        {
          user_id: USER,
          title: "Send the contract",
          notes: "by Friday",
          source: "meeting",
          source_meeting_id: MEETING,
          source_snippet: "I'll send the contract",
        },
        {
          user_id: USER,
          title: "Book the venue",
          notes: null,
          source: "meeting",
          source_meeting_id: MEETING,
          source_snippet: null,
        },
      ],
    ]);
    expect(logInfo.mock.calls[0]).toStrictEqual([
      "tasks_extract_meeting_ok",
      { meetingId: MEETING, count: 2 },
    ]);
  });

  it("writes no tasks when the model finds nothing to extract", async () => {
    generateText.mockResolvedValue(reply({ tasks: [] }));

    await expect(extractTasksFromMeetingTranscript(input())).resolves.toBe(0);
    expect(fake.calls.inserts.filter((w) => w.table === "tasks")).toHaveLength(0);
  });

  it("treats every shape of malformed model output as 'no tasks', never throwing", async () => {
    const malformed = [
      "",
      "I could not find any action items.",
      "{ not json at all",
      JSON.stringify({ tasks: "not an array" }),
      JSON.stringify({ tasks: [{ title: "" }] }),
      JSON.stringify({ tasks: [{ notes: "no title" }] }),
      JSON.stringify({ tasks: Array.from({ length: 11 }, () => ({ title: "too many" })) }),
    ];

    const results: number[] = [];
    for (const text of malformed) {
      fake.reset();
      generateText.mockResolvedValue({ text });
      results.push(await extractTasksFromMeetingTranscript(input()));
      expect(fake.calls.inserts.filter((w) => w.table === "tasks")).toHaveLength(0);
    }

    expect(results).toStrictEqual(malformed.map(() => 0));
  });

  it("swallows a model failure, logging it, and writes no tasks", async () => {
    generateText.mockRejectedValue(new Error("gateway 503"));

    await expect(extractTasksFromMeetingTranscript(input())).resolves.toBe(0);
    expect(logError.mock.calls[0]?.[0]).toBe("tasks_extract_meeting_failed");
    expect(fake.calls.inserts.filter((w) => w.table === "tasks")).toHaveLength(0);
  });

  it("reports zero and logs when the task insert is rejected", async () => {
    generateText.mockResolvedValue(reply({ tasks: [{ title: "Send the contract" }] }));
    fake.onInsert("tasks", () => ({ message: "insert denied" }));

    await expect(extractTasksFromMeetingTranscript(input())).resolves.toBe(0);
    expect(logError.mock.calls[0]).toStrictEqual([
      "tasks_extract_meeting_insert_failed",
      { meetingId: MEETING, err: "insert denied" },
    ]);
    expect(logInfo).not.toHaveBeenCalled();
  });
});
