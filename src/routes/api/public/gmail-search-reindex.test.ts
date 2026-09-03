// Contract for the search backfill cron. Two batched RPC loops, each of which
// stops early on a short batch, is capped by `batches`, and passes the
// encryption key the RPC needs — plus the ordering rule that the participant
// loop does not run at all once the sender loop has failed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import { CRON_SECRET, callCron, cronRequest, handler } from "./__fixtures__/route-harness";
import { Route } from "./gmail-search-reindex";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY = "test-encryption-key";

type ReindexBody = {
  ok: boolean;
  run_id?: string;
  processed?: number;
  participantsProcessed?: number;
  batches?: number;
  error?: string | null;
};

/** Queue up per-call row counts for one RPC. */
function respondWith(fn: string, counts: number[]) {
  let i = 0;
  fake.onRpc(fn, () => ({ data: counts[i++] ?? 0 }));
}

beforeEach(() => {
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(RUN_ID);
  fake.reset();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("EMAIL_ENC_KEY", KEY);
});

describe("configuration", () => {
  it("refuses to run without the encryption key", async () => {
    vi.stubEnv("EMAIL_ENC_KEY", undefined);

    const { status, body } = await callCron<ReindexBody>(Route, "gmail-search-reindex");

    expect(status).toBe(500);
    expect(body).toStrictEqual({ ok: false, error: "EMAIL_ENC_KEY missing" });
    expect(fake.calls.rpcs).toStrictEqual([]);
  });

  it("answers GET with 405 rather than reindexing", async () => {
    const res = await handler(
      Route,
      "GET",
    )({
      request: cronRequest("gmail-search-reindex"),
      params: {},
    });

    expect(res.status).toBe(405);
    expect(fake.calls.rpcs).toStrictEqual([]);
  });
});

describe("batching", () => {
  it("stops each loop as soon as a batch comes back short", async () => {
    respondWith("reindex_email_search_sender", [1000, 1000, 12]);
    respondWith("reindex_email_participants", [4]);

    const { status, body } = await callCron<ReindexBody>(Route, "gmail-search-reindex");

    expect(status).toBe(200);
    expect(body).toStrictEqual({
      ok: true,
      run_id: RUN_ID,
      processed: 2012,
      participantsProcessed: 4,
      batches: 3,
      error: null,
    });
    expect(fake.calls.rpcs.map((r) => r.fn)).toStrictEqual([
      "reindex_email_search_sender",
      "reindex_email_search_sender",
      "reindex_email_search_sender",
      "reindex_email_participants",
    ]);
    expect(fake.calls.rpcs[0]?.args).toStrictEqual({ p_batch_limit: 1000, p_key: KEY });
  });

  it("stops at the batches cap when every batch comes back full", async () => {
    respondWith("reindex_email_search_sender", [1000, 1000, 1000, 1000, 1000, 1000]);
    respondWith("reindex_email_participants", [1000, 1000, 1000, 1000, 1000, 1000]);

    const { body } = await callCron<ReindexBody>(Route, "gmail-search-reindex");

    // Default batches = 5, so 5 000 rows per loop and no sixth call.
    expect(body).toMatchObject({ processed: 5000, participantsProcessed: 5000, batches: 5 });
    expect(fake.calls.rpcs).toHaveLength(10);
  });

  it("honours the batch and batches params, clamped to their ranges", async () => {
    respondWith("reindex_email_search_sender", [1]);
    respondWith("reindex_email_participants", [1]);

    await callCron<ReindexBody>(Route, "gmail-search-reindex", {
      batch: "99999",
      batches: "99",
    });

    expect(fake.calls.rpcs[0]?.args).toStrictEqual({ p_batch_limit: 5000, p_key: KEY });
  });

  it("treats a null RPC result as zero rows and stops", async () => {
    const { body } = await callCron<ReindexBody>(Route, "gmail-search-reindex");

    expect(body).toMatchObject({ processed: 0, participantsProcessed: 0, batches: 1 });
    expect(fake.calls.rpcs.map((r) => r.fn)).toStrictEqual([
      "reindex_email_search_sender",
      "reindex_email_participants",
    ]);
  });
});

describe("failure handling", () => {
  it("reports ok:false and skips the participant loop when the sender loop errors", async () => {
    fake.onRpc("reindex_email_search_sender", () => ({ error: { message: "42703 column gone" } }));

    const { status, body } = await callCron<ReindexBody>(Route, "gmail-search-reindex");

    // 200 with ok:false: the tick ran, the work did not. A 500 here would
    // make the cron scheduler retry a schema problem every minute.
    expect(status).toBe(200);
    expect(body).toStrictEqual({
      ok: false,
      run_id: RUN_ID,
      processed: 0,
      participantsProcessed: 0,
      batches: 0,
      error: "42703 column gone",
    });
    expect(fake.calls.rpcs.map((r) => r.fn)).toStrictEqual(["reindex_email_search_sender"]);
  });

  it("keeps the sender progress when only the participant loop errors", async () => {
    respondWith("reindex_email_search_sender", [7]);
    fake.onRpc("reindex_email_participants", () => ({ error: { message: "lock timeout" } }));

    const { body } = await callCron<ReindexBody>(Route, "gmail-search-reindex");

    expect(body).toMatchObject({
      ok: false,
      processed: 7,
      participantsProcessed: 0,
      batches: 1,
      error: "lock timeout",
    });
  });

  it("returns a JSON 500 rather than an unhandled rejection when an RPC throws", async () => {
    fake.onRpc("reindex_email_search_sender", () => {
      throw new Error("connection terminated");
    });

    const { status, body } = await callCron<ReindexBody>(Route, "gmail-search-reindex");

    expect(status).toBe(500);
    expect(body).toStrictEqual({
      ok: false,
      error: "connection terminated",
      run_id: RUN_ID,
    });
  });
});
