// Contract for the daily retention cron: the four cleanup RPCs it calls, the
// arguments it clamps them to, the fact that one failing table does not stop
// the other three, and the audit row + JSON body it produces.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writesTo } from "@/lib/__fixtures__/supabase-fake";
import { CRON_SECRET, callCron, cronRequest, handler } from "./__fixtures__/route-harness";
import { Route } from "./gmail-retention";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type RetentionBody = {
  ok: boolean;
  pubsub: unknown;
  dlq: unknown;
  scheduled: unknown;
  digest: unknown;
  pubsubError: string | null;
  dlqError: string | null;
  scheduledError: string | null;
  digestError: string | null;
  run_id: string;
};

function stubAllCleanups() {
  fake.onRpc("cleanup_old_pubsub_events", () => ({
    data: [{ deleted: 10, kept_errors: 2, total_before: 100 }],
  }));
  fake.onRpc("cleanup_old_dlq_jobs", () => ({ data: [{ deleted: 5, total_before: 40 }] }));
  fake.onRpc("cleanup_old_scheduled_actions", () => ({
    data: [{ deleted: 3, kept_errors: 1, total_before: 30 }],
  }));
  fake.onRpc("cleanup_old_digest_items", () => ({ data: [{ deleted: 7, total_before: 70 }] }));
}

beforeEach(() => {
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(RUN_ID);
  fake.reset();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
});

describe("happy path", () => {
  it("prunes all four tables with the default retention windows", async () => {
    stubAllCleanups();

    const { status, body } = await callCron<RetentionBody>(Route, "gmail-retention");

    expect(status).toBe(200);
    expect(body).toStrictEqual({
      ok: true,
      pubsub: { deleted: 10, kept_errors: 2, total_before: 100 },
      dlq: { deleted: 5, total_before: 40 },
      scheduled: { deleted: 3, kept_errors: 1, total_before: 30 },
      digest: { deleted: 7, total_before: 70 },
      pubsubError: null,
      dlqError: null,
      scheduledError: null,
      digestError: null,
      run_id: RUN_ID,
    });
    expect(fake.calls.rpcs).toStrictEqual([
      {
        fn: "cleanup_old_pubsub_events",
        args: { p_keep_days: 30, p_keep_errors_days: 60, p_batch_limit: 5000 },
      },
      { fn: "cleanup_old_dlq_jobs", args: { p_keep_days: 30, p_batch_limit: 1000 } },
      {
        fn: "cleanup_old_scheduled_actions",
        args: { p_keep_days: 30, p_keep_errors_days: 60, p_batch_limit: 5000 },
      },
      { fn: "cleanup_old_digest_items", args: { p_keep_days: 30, p_batch_limit: 5000 } },
    ]);
  });

  it("writes one audit row naming what was pruned from each table", async () => {
    stubAllCleanups();

    await callCron<RetentionBody>(Route, "gmail-retention");

    expect(writesTo(fake, "inserts", "pubsub_events").map((w) => w.payload)).toStrictEqual([
      {
        event_type: "retention",
        details:
          "pubsub: deleted=10 of 100 (kept 2 error rows); dlq: deleted=5 of 40; " +
          "scheduled_actions: deleted=3 of 30 (kept 1 error rows); digest_items: deleted=7 of 70",
        error: null,
      },
    ]);
  });

  it("honours the tuning query params", async () => {
    stubAllCleanups();

    await callCron<RetentionBody>(Route, "gmail-retention", {
      pubsub_keep_days: "7",
      pubsub_keep_errors_days: "14",
      pubsub_limit: "100",
      dlq_keep_days: "3",
      dlq_limit: "50",
      scheduled_keep_days: "5",
      scheduled_keep_errors_days: "9",
      scheduled_limit: "250",
      digest_keep_days: "2",
      digest_limit: "80",
    });

    expect(fake.calls.rpcs.map((r) => r.args)).toStrictEqual([
      { p_keep_days: 7, p_keep_errors_days: 14, p_batch_limit: 100 },
      { p_keep_days: 3, p_batch_limit: 50 },
      { p_keep_days: 5, p_keep_errors_days: 9, p_batch_limit: 250 },
      { p_keep_days: 2, p_batch_limit: 80 },
    ]);
  });

  it("clamps out-of-range and unparseable params to safe values", async () => {
    stubAllCleanups();

    await callCron<RetentionBody>(Route, "gmail-retention", {
      pubsub_keep_days: "0",
      pubsub_limit: "999999",
      dlq_keep_days: "forever",
      dlq_limit: "999999",
    });

    const [pubsub, dlq] = fake.calls.rpcs;
    expect(pubsub?.args).toStrictEqual({
      p_keep_days: 1,
      p_keep_errors_days: 60,
      p_batch_limit: 50_000,
    });
    expect(dlq?.args).toStrictEqual({ p_keep_days: 30, p_batch_limit: 10_000 });
  });

  it("answers GET with 405 rather than pruning", async () => {
    const res = await handler(
      Route,
      "GET",
    )({
      request: cronRequest("gmail-retention"),
      params: {},
    });

    expect(res.status).toBe(405);
    expect(fake.calls.rpcs).toStrictEqual([]);
  });
});

describe("failure handling", () => {
  it("reports an RPC error per table and still prunes the others", async () => {
    stubAllCleanups();
    fake.onRpc("cleanup_old_dlq_jobs", () => ({ error: { message: "deadlock detected" } }));

    const { status, body } = await callCron<RetentionBody>(Route, "gmail-retention");

    // Still ok:true and 200 — a partial prune is not a failed tick, and the
    // per-table error fields are how a caller learns what did not run.
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      dlq: null,
      dlqError: "deadlock detected",
      pubsub: { deleted: 10, kept_errors: 2, total_before: 100 },
      digest: { deleted: 7, total_before: 70 },
    });
  });

  it("reports a thrown RPC the same way as a returned error", async () => {
    stubAllCleanups();
    fake.onRpc("cleanup_old_scheduled_actions", () => {
      throw new Error("statement timeout");
    });

    const { body } = await callCron<RetentionBody>(Route, "gmail-retention");

    expect(body).toMatchObject({ scheduled: null, scheduledError: "statement timeout" });
  });

  it("surfaces the first failing table in the audit row", async () => {
    stubAllCleanups();
    fake.onRpc("cleanup_old_pubsub_events", () => ({ error: { message: "no such function" } }));
    fake.onRpc("cleanup_old_digest_items", () => ({ error: { message: "also broken" } }));

    await callCron<RetentionBody>(Route, "gmail-retention");

    expect(writesTo(fake, "inserts", "pubsub_events")[0]?.payload).toMatchObject({
      error: "no such function",
      details:
        "pubsub: deleted=? of ? (kept ? error rows); dlq: deleted=5 of 40; " +
        "scheduled_actions: deleted=3 of 30 (kept 1 error rows); digest_items: deleted=? of ?",
    });
  });

  it("treats an RPC that is not deployed yet as a null result, not a crash", async () => {
    const { status, body } = await callCron<RetentionBody>(Route, "gmail-retention");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      pubsub: null,
      dlq: null,
      scheduled: null,
      digest: null,
      pubsubError: null,
    });
  });
});
