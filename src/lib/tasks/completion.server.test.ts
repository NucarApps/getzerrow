// Tests for scanSentForTaskCompletion (src/lib/tasks/completion.server.ts), the
// cron that correlates recent Sent mail with open tasks. The AI call is never
// exercised here — we cover the control flow around it: empty inputs, the
// no-open-tasks short-circuit, resilience when the model is unavailable, and
// per-user error isolation so one bad user never aborts the whole scan.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (t: string) => fake.supabaseAdmin.from(t),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

const getEmailListFieldsDecrypted = vi.fn(async (..._args: unknown[]) => ({
  rows: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/sync/encrypted-reader", () => ({
  getEmailListFieldsDecrypted: (...args: unknown[]) => getEmailListFieldsDecrypted(...args),
}));
vi.mock("@/lib/ai-gateway", () => ({ createLovableAiGatewayProvider: vi.fn(() => () => ({})) }));
vi.mock("@/lib/log.server", () => ({ logError: vi.fn(), logInfo: vi.fn() }));

import { scanSentForTaskCompletion } from "./completion.server";

const FUTURE = "2999-01-01T00:00:00Z"; // always within the lookback window

beforeEach(() => {
  fake.reset();
  getEmailListFieldsDecrypted.mockReset();
  getEmailListFieldsDecrypted.mockResolvedValue({ rows: [] });
  delete process.env.LOVABLE_API_KEY; // force the AI-unavailable branch
});

describe("scanSentForTaskCompletion", () => {
  it("returns zero when there is no recent Sent activity", async () => {
    const res = await scanSentForTaskCompletion();
    expect(res).toEqual({ users: 0, inserted: 0 });
  });

  it("counts the user but inserts nothing when they have no open tasks", async () => {
    fake.seed("emails", [
      { id: "e1", user_id: "u1", raw_labels: ["SENT"], received_at: FUTURE, from_addr: "u1@x.com" },
    ]);
    const res = await scanSentForTaskCompletion();
    expect(res).toEqual({ users: 1, inserted: 0 });
    // Short-circuits before decrypting any email bodies.
    expect(getEmailListFieldsDecrypted).not.toHaveBeenCalled();
  });

  it("does not insert suggestions when the model is unavailable", async () => {
    fake.seed("emails", [
      { id: "e1", user_id: "u1", raw_labels: ["SENT"], received_at: FUTURE, from_addr: "u1@x.com" },
    ]);
    fake.seed("tasks", [
      {
        id: "t1",
        user_id: "u1",
        title: "Send report",
        notes: null,
        source: "manual",
        status: "open",
      },
    ]);
    getEmailListFieldsDecrypted.mockResolvedValue({
      rows: [{ id: "e1", subject: "Re: report", snippet: "attached", to_addrs: "boss@x.com" }],
    });

    const res = await scanSentForTaskCompletion();
    expect(res).toEqual({ users: 1, inserted: 0 });
    expect(
      fake.calls.inserts.filter((i) => i.table === "task_completion_suggestions"),
    ).toHaveLength(0);
  });

  it("isolates a per-user failure without aborting the whole scan", async () => {
    fake.seed("emails", [
      { id: "e1", user_id: "u1", raw_labels: ["SENT"], received_at: FUTURE, from_addr: "u1@x.com" },
    ]);
    fake.seed("tasks", [
      {
        id: "t1",
        user_id: "u1",
        title: "Send report",
        notes: null,
        source: "manual",
        status: "open",
      },
    ]);
    // Decryption blows up for this user; the cron must swallow it and move on.
    getEmailListFieldsDecrypted.mockRejectedValue(new Error("decrypt boom"));

    const res = await scanSentForTaskCompletion();
    expect(res).toEqual({ users: 1, inserted: 0 });
  });
});
