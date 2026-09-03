// Contract for the DLQ auto-replay cron: the two independent drains it runs,
// the limits it clamps them to, and the fact that either one failing leaves
// the other's result intact rather than failing the whole tick.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writesTo } from "@/lib/__fixtures__/supabase-fake";
import { CRON_SECRET, callCron, cronRequest, handler } from "./__fixtures__/route-harness";
import { Route } from "./gmail-dlq-replay";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const replayTransientDlq = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/sync.server").replayTransientDlq>(),
);
const retryForwardAttempts = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/sync.server").retryForwardAttempts>(),
);
vi.mock("@/lib/sync.server", () => ({ replayTransientDlq, retryForwardAttempts }));

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type DlqBody = {
  ok: boolean;
  dlq: unknown;
  forwards: unknown;
  run_id: string;
};

beforeEach(() => {
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(RUN_ID);
  fake.reset();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  replayTransientDlq.mockResolvedValue({ checked: 12, replayed: 4, skipped: 8 });
  retryForwardAttempts.mockResolvedValue({ processed: 4, ok: 3, failed: 1, gaveUp: 0 });
});

describe("happy path", () => {
  it("runs both drains with the default limits and returns both results", async () => {
    const { status, body } = await callCron<DlqBody>(Route, "gmail-dlq-replay");

    expect(status).toBe(200);
    expect(body).toStrictEqual({
      ok: true,
      dlq: { checked: 12, replayed: 4, skipped: 8 },
      forwards: { processed: 4, ok: 3, failed: 1, gaveUp: 0 },
      run_id: RUN_ID,
    });
    expect(replayTransientDlq).toHaveBeenCalledWith(200);
    expect(retryForwardAttempts).toHaveBeenCalledWith(50);
  });

  it("records one audit row summarising both drains", async () => {
    await callCron<DlqBody>(Route, "gmail-dlq-replay");

    expect(writesTo(fake, "inserts", "pubsub_events").map((w) => w.payload)).toStrictEqual([
      {
        event_type: "dlq_replay",
        details: "DLQ replayed 4/12; forwards ok=3 failed=1 gaveUp=0",
        error: null,
      },
    ]);
  });

  it("clamps the limit params to their ranges", async () => {
    await callCron<DlqBody>(Route, "gmail-dlq-replay", { limit: "9999", forwardLimit: "0" });

    expect(replayTransientDlq).toHaveBeenCalledWith(500);
    expect(retryForwardAttempts).toHaveBeenCalledWith(1);
  });

  it("falls back to the defaults for unparseable limits", async () => {
    await callCron<DlqBody>(Route, "gmail-dlq-replay", { limit: "all", forwardLimit: "lots" });

    expect(replayTransientDlq).toHaveBeenCalledWith(200);
    expect(retryForwardAttempts).toHaveBeenCalledWith(50);
  });

  it("answers GET with 405 rather than replaying", async () => {
    const res = await handler(
      Route,
      "GET",
    )({
      request: cronRequest("gmail-dlq-replay"),
      params: {},
    });

    expect(res.status).toBe(405);
    expect(replayTransientDlq).not.toHaveBeenCalled();
  });
});

describe("failure handling", () => {
  it("still runs the forward retries when the DLQ replay throws", async () => {
    replayTransientDlq.mockRejectedValue(new Error("claim deadlock"));

    const { status, body } = await callCron<DlqBody>(Route, "gmail-dlq-replay");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      dlq: null,
      forwards: { processed: 4, ok: 3, failed: 1, gaveUp: 0 },
    });
    expect(retryForwardAttempts).toHaveBeenCalledWith(50);
    expect(writesTo(fake, "inserts", "pubsub_events")[0]?.payload).toMatchObject({
      details: "DLQ replayed 0/0; forwards ok=3 failed=1 gaveUp=0",
      error: "claim deadlock",
    });
  });

  it("keeps the DLQ result when only the forward retries throw", async () => {
    retryForwardAttempts.mockRejectedValue(new Error("smtp refused"));

    const { body } = await callCron<DlqBody>(Route, "gmail-dlq-replay");

    expect(body).toMatchObject({
      ok: true,
      dlq: { checked: 12, replayed: 4, skipped: 8 },
      forwards: null,
    });
    expect(writesTo(fake, "inserts", "pubsub_events")[0]?.payload).toMatchObject({
      details: "DLQ replayed 4/12; forwards ok=0 failed=0 gaveUp=0",
      error: "smtp refused",
    });
  });

  it("reports the DLQ error in preference to the forward error when both fail", async () => {
    replayTransientDlq.mockRejectedValue(new Error("claim deadlock"));
    retryForwardAttempts.mockRejectedValue(new Error("smtp refused"));

    const { body } = await callCron<DlqBody>(Route, "gmail-dlq-replay");

    expect(body).toMatchObject({ ok: true, dlq: null, forwards: null });
    expect(writesTo(fake, "inserts", "pubsub_events")[0]?.payload).toMatchObject({
      error: "claim deadlock",
    });
  });

  it("still returns 200 when the audit row cannot be written", async () => {
    fake.onInsert("pubsub_events", () => {
      throw new Error("insert exploded");
    });

    const { status, body } = await callCron<DlqBody>(Route, "gmail-dlq-replay");

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, dlq: { checked: 12, replayed: 4, skipped: 8 } });
  });
});
