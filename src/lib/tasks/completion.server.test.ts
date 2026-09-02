// Tests for scanSentForTaskCompletion (src/lib/tasks/completion.server.ts),
// the cron that correlates recent Sent mail with open tasks. The model is
// stubbed rather than disabled, so the parts that only run once it answers
// are covered too: the insert payload, the guard that a match must name a
// task we actually sent the model (a hallucinated uuid must not create a
// suggestion against someone's task), and the already-scored pair skip that
// keeps the cron from re-billing the same work every run.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const { generateText, getEmailListFieldsDecrypted, logError, logInfo } = vi.hoisted(() => ({
  generateText: vi.fn(async (_args: unknown) => ({ text: "" })),
  getEmailListFieldsDecrypted:
    vi.fn<typeof import("@/lib/sync/encrypted-reader").getEmailListFieldsDecrypted>(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("ai", () => ({ generateText }));
vi.mock("@/lib/sync/encrypted-reader", () => ({ getEmailListFieldsDecrypted }));
vi.mock("@/lib/ai-gateway", () => ({ getModel: vi.fn((id: string) => ({ id })) }));
vi.mock("@/lib/log.server", () => ({ logError, logInfo, logAudit: vi.fn() }));

import { scanSentForTaskCompletion } from "./completion.server";

const USER = "u1";
const TASK = "11111111-1111-4111-8111-111111111111";
const OTHER_TASK = "22222222-2222-4222-8222-222222222222";
const HALLUCINATED = "99999999-9999-4999-8999-999999999999";
const SENT_EMAIL = "e1";
const NOW = "2026-03-01T12:00:00Z";
const RECENT = "2026-03-01T09:00:00Z"; // inside the 24 h lookback
const STALE = "2026-02-20T09:00:00Z"; // outside it

function seedSentEmail(overrides?: { id?: string; receivedAt?: string; labels?: string[] }) {
  fake.seed("emails", [
    ...fake.rows("emails"),
    {
      id: overrides?.id ?? SENT_EMAIL,
      user_id: USER,
      raw_labels: overrides?.labels ?? ["SENT"],
      received_at: overrides?.receivedAt ?? RECENT,
      from_addr: "me@acme.com",
    },
  ]);
}

function seedOpenTask(id: string, title: string) {
  fake.seed("tasks", [
    ...fake.rows("tasks"),
    { id, user_id: USER, title, notes: null, source: "manual", status: "open" },
  ]);
}

function decryptedAs(rows: Array<Record<string, unknown>>) {
  getEmailListFieldsDecrypted.mockResolvedValue({
    rows,
  } as unknown as Awaited<ReturnType<typeof getEmailListFieldsDecrypted>>);
}

/** A model reply naming the given matches. */
function matches(items: Array<{ task_id: string; confidence: string; reasoning: string }>) {
  return { text: JSON.stringify({ matches: items }) };
}

beforeEach(() => {
  fake.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  generateText.mockResolvedValue({ text: JSON.stringify({ matches: [] }) });
  decryptedAs([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scanSentForTaskCompletion", () => {
  it("returns zero when there is no recent Sent activity", async () => {
    await expect(scanSentForTaskCompletion()).resolves.toStrictEqual({ users: 0, inserted: 0 });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("ignores Sent mail older than the lookback window", async () => {
    seedSentEmail({ receivedAt: STALE });

    await expect(scanSentForTaskCompletion()).resolves.toStrictEqual({ users: 0, inserted: 0 });
  });

  it("ignores mail that is not in SENT", async () => {
    seedSentEmail({ labels: ["INBOX"] });

    await expect(scanSentForTaskCompletion()).resolves.toStrictEqual({ users: 0, inserted: 0 });
  });

  it("counts the user but decrypts nothing when they have no open tasks", async () => {
    seedSentEmail();

    await expect(scanSentForTaskCompletion()).resolves.toStrictEqual({ users: 1, inserted: 0 });
    expect(getEmailListFieldsDecrypted).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("records one suggestion per match, with the model's confidence and reasoning", async () => {
    seedSentEmail();
    seedOpenTask(TASK, "Send the report");
    decryptedAs([
      { id: SENT_EMAIL, subject: "Re: report", snippet: "attached", to_addrs: "boss@acme.com" },
    ]);
    generateText.mockResolvedValue(
      matches([{ task_id: TASK, confidence: "high", reasoning: "the report is attached" }]),
    );

    await expect(scanSentForTaskCompletion()).resolves.toStrictEqual({ users: 1, inserted: 1 });

    expect(
      fake.calls.inserts
        .filter((w) => w.table === "task_completion_suggestions")
        .map((w) => w.payload),
    ).toStrictEqual([
      {
        user_id: USER,
        task_id: TASK,
        sent_email_id: SENT_EMAIL,
        confidence: "high",
        reasoning: "the report is attached",
      },
    ]);
    expect(logInfo.mock.calls[0]).toStrictEqual([
      "tasks_completion_scan_user",
      { userId: USER, inserted: 1, sent: 1 },
    ]);
  });

  it("prompts the model with only the user's own open tasks and the sent email", async () => {
    seedSentEmail();
    seedOpenTask(TASK, "Send the report");
    decryptedAs([
      { id: SENT_EMAIL, subject: "Re: report", snippet: "attached", to_addrs: "boss@acme.com" },
    ]);

    await scanSentForTaskCompletion();

    const messages = (
      generateText.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> }
    ).messages;
    expect(messages[1]?.content).toBe(
      [
        "SENT EMAIL:",
        "To: boss@acme.com",
        "Subject: Re: report",
        "Snippet: attached",
        "",
        "OPEN TASKS:",
        `- id=${TASK} | Send the report`,
      ].join("\n"),
    );
  });

  it("drops a match naming a task the model was never given", async () => {
    seedSentEmail();
    seedOpenTask(TASK, "Send the report");
    decryptedAs([{ id: SENT_EMAIL, subject: "Re: report", snippet: "", to_addrs: "" }]);
    generateText.mockResolvedValue(
      matches([
        { task_id: HALLUCINATED, confidence: "high", reasoning: "invented" },
        { task_id: TASK, confidence: "med", reasoning: "real" },
      ]),
    );

    await expect(scanSentForTaskCompletion()).resolves.toStrictEqual({ users: 1, inserted: 1 });

    const inserts = fake.calls.inserts.filter((w) => w.table === "task_completion_suggestions");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.payload).toMatchObject({ task_id: TASK, reasoning: "real" });
  });

  it("skips a task/email pair that was already scored, and the model call with it", async () => {
    seedSentEmail();
    seedOpenTask(TASK, "Send the report");
    fake.seed("task_completion_suggestions", [
      { id: "s1", user_id: USER, task_id: TASK, sent_email_id: SENT_EMAIL, status: "pending" },
    ]);
    decryptedAs([{ id: SENT_EMAIL, subject: "Re: report", snippet: "", to_addrs: "" }]);

    await expect(scanSentForTaskCompletion()).resolves.toStrictEqual({ users: 1, inserted: 0 });
    expect(
      generateText,
      "an already-scored pair must not be re-sent to the model",
    ).not.toHaveBeenCalled();
  });

  it("still scores the tasks that have not been paired with this email yet", async () => {
    seedSentEmail();
    seedOpenTask(TASK, "Send the report");
    seedOpenTask(OTHER_TASK, "Book the venue");
    fake.seed("task_completion_suggestions", [
      { id: "s1", user_id: USER, task_id: TASK, sent_email_id: SENT_EMAIL, status: "pending" },
    ]);
    decryptedAs([{ id: SENT_EMAIL, subject: "Re: venue", snippet: "", to_addrs: "" }]);
    generateText.mockResolvedValue(
      matches([
        { task_id: TASK, confidence: "high", reasoning: "already scored" },
        { task_id: OTHER_TASK, confidence: "high", reasoning: "venue booked" },
      ]),
    );

    await expect(scanSentForTaskCompletion()).resolves.toStrictEqual({ users: 1, inserted: 1 });

    const messages = (
      generateText.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> }
    ).messages;
    expect(messages[1]?.content).toContain(`- id=${OTHER_TASK} | Book the venue`);
    expect(messages[1]?.content).not.toContain(`- id=${TASK} |`);
    const inserts = fake.calls.inserts.filter((w) => w.table === "task_completion_suggestions");
    expect(inserts.map((w) => (w.payload as { task_id: string }).task_id)).toStrictEqual([
      OTHER_TASK,
    ]);
  });

  it("logs and moves on when the model call fails", async () => {
    seedSentEmail();
    seedOpenTask(TASK, "Send the report");
    decryptedAs([{ id: SENT_EMAIL, subject: "Re: report", snippet: "", to_addrs: "" }]);
    generateText.mockRejectedValue(new Error("gateway 503"));

    await expect(scanSentForTaskCompletion()).resolves.toStrictEqual({ users: 1, inserted: 0 });
    expect(logError.mock.calls[0]?.[0]).toBe("tasks_completion_llm_failed");
    expect(
      fake.calls.inserts.filter((w) => w.table === "task_completion_suggestions"),
    ).toHaveLength(0);
  });

  it("logs and moves on when the model's reply cannot be parsed", async () => {
    seedSentEmail();
    seedOpenTask(TASK, "Send the report");
    decryptedAs([{ id: SENT_EMAIL, subject: "Re: report", snippet: "", to_addrs: "" }]);
    generateText.mockResolvedValue({ text: "I think task one is done." });

    await expect(scanSentForTaskCompletion()).resolves.toStrictEqual({ users: 1, inserted: 0 });
    expect(logError.mock.calls[0]?.[2]).toStrictEqual(new Error("unparseable AI response"));
  });

  it("does not count a suggestion the database rejected", async () => {
    seedSentEmail();
    seedOpenTask(TASK, "Send the report");
    decryptedAs([{ id: SENT_EMAIL, subject: "Re: report", snippet: "", to_addrs: "" }]);
    generateText.mockResolvedValue(
      matches([{ task_id: TASK, confidence: "high", reasoning: "done" }]),
    );
    fake.onInsert("task_completion_suggestions", () => ({ message: "insert denied" }));

    await expect(scanSentForTaskCompletion()).resolves.toStrictEqual({ users: 1, inserted: 0 });
  });

  it("isolates a per-user failure without aborting the whole scan", async () => {
    seedSentEmail();
    seedOpenTask(TASK, "Send the report");
    getEmailListFieldsDecrypted.mockRejectedValue(new Error("decrypt boom"));

    await expect(scanSentForTaskCompletion()).resolves.toStrictEqual({ users: 1, inserted: 0 });
    expect(logError.mock.calls[0]?.[0]).toBe("tasks_completion_scan_user_failed");
  });
});
