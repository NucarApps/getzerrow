// Unit tests for the task server functions
// (src/lib/tasks/crud.functions.ts). Every write here carries BOTH the
// row id and `user_id = context.userId`, on top of RLS on
// `context.supabase` — belt and braces. These tests hold that second belt
// in place: the fake applies writes, so a call made as another user is
// shown to leave the victim's row byte-for-byte unchanged.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { callWithRlsClient } from "@/lib/__fixtures__/rls-server-fn";

const fake = makeSupabaseFake({ applyWrites: true });

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));

import {
  completeTask,
  confirmCompletionSuggestion,
  createTask,
  deleteTask,
  dismissCompletionSuggestion,
  dismissTask,
  listTasks,
  reopenTask,
} from "./crud.functions";

const TASK = "11111111-1111-4111-8111-111111111111";
const OTHER_TASK = "22222222-2222-4222-8222-222222222222";
const SUGGESTION = "33333333-3333-4333-8333-333333333333";
const EMAIL = "44444444-4444-4444-8444-444444444444";
const ATTACKER = "attacker-user";

const call = <F extends (args: never) => Promise<unknown>>(fn: F) =>
  callWithRlsClient(fn, { fake });
const callAs = <F extends (args: never) => Promise<unknown>>(fn: F, userId: string) =>
  callWithRlsClient(fn, { fake, userId });

function seedOpenTask() {
  fake.seed("tasks", [
    {
      id: TASK,
      user_id: TEST_USER,
      title: "Send the contract",
      notes: null,
      status: "open",
      due_at: null,
      source: "manual",
      source_meeting_id: null,
      source_email_id: null,
      source_snippet: null,
      completed_at: null,
      dismissed_at: null,
      created_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    },
  ]);
}

beforeEach(() => {
  fake.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
});

describe("listTasks", () => {
  it("returns only the caller's tasks with their pending suggestions", async () => {
    seedOpenTask();
    fake.seed("tasks", [
      ...fake.rows("tasks"),
      { id: OTHER_TASK, user_id: ATTACKER, title: "Not yours", status: "open", source: "manual" },
    ]);
    fake.seed("task_completion_suggestions", [
      {
        id: SUGGESTION,
        user_id: TEST_USER,
        task_id: TASK,
        sent_email_id: EMAIL,
        confidence: "0.9",
        reasoning: "you replied with the contract",
        status: "pending",
        created_at: "2026-02-01T00:00:00Z",
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        user_id: TEST_USER,
        task_id: TASK,
        sent_email_id: EMAIL,
        confidence: "0.4",
        reasoning: "already handled",
        status: "dismissed",
        created_at: "2026-02-01T00:00:00Z",
      },
    ]);

    const result = await call(listTasks)({ data: {} });

    expect(result.tasks.map((t) => t.id)).toStrictEqual([TASK]);
    expect(result.suggestions.map((s) => s.id)).toStrictEqual([SUGGESTION]);
  });

  it("adds the status and source filters only when they are not 'all'", async () => {
    seedOpenTask();

    await call(listTasks)({ data: { status: "all", source: "all" } });
    expect(fake.calls.selects[0]?.filters).toStrictEqual([
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
    ]);

    await call(listTasks)({ data: { status: "done", source: "meeting" } });
    expect(fake.calls.selects[2]?.filters).toStrictEqual([
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
      { op: "eq", col: "status", value: "done", extra: undefined },
      { op: "eq", col: "source", value: "meeting", extra: undefined },
    ]);
  });

  it("surfaces a failing task read", async () => {
    fake.onSelect("tasks", () => ({ message: "permission denied for table tasks" }));

    await expect(call(listTasks)({ data: {} })).rejects.toThrow(
      "permission denied for table tasks",
    );
  });
});

describe("createTask", () => {
  it("stamps the caller's id and defaults the optional fields", async () => {
    const result = await call(createTask)({ data: { title: "  Book the venue  " } });

    expect(fake.calls.inserts.map((w) => [w.table, w.payload])).toStrictEqual([
      [
        "tasks",
        {
          user_id: TEST_USER,
          title: "Book the venue",
          notes: null,
          due_at: null,
          source: "manual",
        },
      ],
    ]);
    expect(result.task).toMatchObject({ title: "Book the venue", user_id: TEST_USER });
  });

  it("surfaces a rejected insert", async () => {
    fake.onInsert("tasks", () => ({ message: "insert denied" }));

    await expect(call(createTask)({ data: { title: "x" } })).rejects.toThrow("insert denied");
  });
});

describe("completeTask / reopenTask / dismissTask / deleteTask", () => {
  it("completes the caller's own task with a timestamp", async () => {
    seedOpenTask();

    await expect(call(completeTask)({ data: { id: TASK } })).resolves.toStrictEqual({ ok: true });
    expect(fake.rows("tasks")[0]).toMatchObject({
      status: "done",
      completed_at: "2026-03-01T12:00:00.000Z",
    });
  });

  it("reopening clears both terminal timestamps", async () => {
    fake.seed("tasks", [
      {
        id: TASK,
        user_id: TEST_USER,
        status: "dismissed",
        completed_at: "2026-02-01T00:00:00Z",
        dismissed_at: "2026-02-01T00:00:00Z",
      },
    ]);

    await call(reopenTask)({ data: { id: TASK } });

    expect(fake.rows("tasks")[0]).toMatchObject({
      status: "open",
      completed_at: null,
      dismissed_at: null,
    });
  });

  it("dismisses the caller's own task with a timestamp", async () => {
    seedOpenTask();

    await call(dismissTask)({ data: { id: TASK } });

    expect(fake.rows("tasks")[0]).toMatchObject({
      status: "dismissed",
      dismissed_at: "2026-03-01T12:00:00.000Z",
    });
  });

  it("deletes the caller's own task", async () => {
    seedOpenTask();

    await call(deleteTask)({ data: { id: TASK } });

    expect(fake.rows("tasks")).toStrictEqual([]);
  });

  it("leaves another user's task untouched on every mutating path", async () => {
    for (const fn of [completeTask, reopenTask, dismissTask, deleteTask]) {
      fake.reset();
      seedOpenTask();
      const before = fake.rows("tasks");

      // The handlers report success either way — a no-op UPDATE is not an
      // error in PostgREST — so the proof is that the row did not change.
      await expect(callAs(fn, ATTACKER)({ data: { id: TASK } })).resolves.toStrictEqual({
        ok: true,
      });

      expect(fake.rows("tasks")).toStrictEqual(before);
      const write = [...fake.calls.updates, ...fake.calls.deletes][0];
      expect(write?.filters).toStrictEqual([
        { op: "eq", col: "id", value: TASK, extra: undefined },
        { op: "eq", col: "user_id", value: ATTACKER, extra: undefined },
      ]);
    }
  });

  it("surfaces a rejected update", async () => {
    fake.onUpdate("tasks", () => ({ message: "update denied" }));

    await expect(call(completeTask)({ data: { id: TASK } })).rejects.toThrow("update denied");
  });
});

describe("confirmCompletionSuggestion", () => {
  function seedPendingSuggestion(ownerId: string = TEST_USER) {
    seedOpenTask();
    fake.seed("task_completion_suggestions", [
      {
        id: SUGGESTION,
        user_id: ownerId,
        task_id: TASK,
        sent_email_id: EMAIL,
        status: "pending",
      },
    ]);
  }

  it("refuses another user's suggestion and completes nothing", async () => {
    seedPendingSuggestion();
    const before = fake.rows("tasks");

    await expect(
      callAs(confirmCompletionSuggestion, ATTACKER)({ data: { id: SUGGESTION } }),
    ).rejects.toThrow("Suggestion not found");
    expect(writeCount(fake)).toBe(0);
    expect(fake.rows("tasks")).toStrictEqual(before);
  });

  it("confirms the suggestion and completes its task", async () => {
    seedPendingSuggestion();

    await expect(
      call(confirmCompletionSuggestion)({ data: { id: SUGGESTION } }),
    ).resolves.toStrictEqual({ ok: true });

    expect(fake.rows("task_completion_suggestions")[0]).toMatchObject({ status: "confirmed" });
    expect(fake.rows("tasks")[0]).toMatchObject({
      status: "done",
      completed_at: "2026-03-01T12:00:00.000Z",
    });
    expect(fake.calls.updates.map((w) => [w.table, w.filters])).toStrictEqual([
      [
        "task_completion_suggestions",
        [
          { op: "eq", col: "id", value: SUGGESTION, extra: undefined },
          { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
        ],
      ],
      [
        "tasks",
        [
          { op: "eq", col: "id", value: TASK, extra: undefined },
          { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
        ],
      ],
    ]);
  });

  it("surfaces a failing suggestion read before writing anything", async () => {
    fake.onSelect("task_completion_suggestions", () => ({ message: "read denied" }));

    await expect(call(confirmCompletionSuggestion)({ data: { id: SUGGESTION } })).rejects.toThrow(
      "read denied",
    );
    expect(writeCount(fake)).toBe(0);
  });
});

describe("dismissCompletionSuggestion", () => {
  it("dismisses only the caller's own suggestion", async () => {
    fake.seed("task_completion_suggestions", [
      { id: SUGGESTION, user_id: TEST_USER, task_id: TASK, status: "pending" },
    ]);

    await expect(
      call(dismissCompletionSuggestion)({ data: { id: SUGGESTION } }),
    ).resolves.toStrictEqual({ ok: true });

    expect(fake.rows("task_completion_suggestions")[0]).toMatchObject({ status: "dismissed" });
    expect(fake.calls.updates[0]?.filters).toStrictEqual([
      { op: "eq", col: "id", value: SUGGESTION, extra: undefined },
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
    ]);
  });

  it("leaves another user's suggestion pending", async () => {
    fake.seed("task_completion_suggestions", [
      { id: SUGGESTION, user_id: TEST_USER, task_id: TASK, status: "pending" },
    ]);

    await callAs(dismissCompletionSuggestion, ATTACKER)({ data: { id: SUGGESTION } });

    expect(fake.rows("task_completion_suggestions")[0]).toMatchObject({ status: "pending" });
  });

  it("surfaces a rejected update", async () => {
    fake.onUpdate("task_completion_suggestions", () => ({ message: "update denied" }));

    await expect(call(dismissCompletionSuggestion)({ data: { id: SUGGESTION } })).rejects.toThrow(
      "update denied",
    );
  });
});
