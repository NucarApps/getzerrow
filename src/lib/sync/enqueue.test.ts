// Unit tests for the message-jobs enqueue primitives. Contracts protected:
//
//   * enqueueMessageJobs upserts rows keyed on
//     (gmail_account_id, gmail_message_id) with ignoreDuplicates: true —
//     re-enqueueing an already-pending message is a no-op, which is what
//     makes Pub/Sub redelivery and overlapping backfill/history sync safe,
//   * row shape: status='pending', caller's priority lane, published_at_ms
//     carried through, and next_run_at staggered 1ms per row (idx % 500)
//     so a burst doesn't collide on one claim instant,
//   * big enqueues are chunked at 500 rows per upsert; a failed chunk
//     throws the Supabase error and aborts the remaining chunks,
//   * an empty id list is a no-op (no DB roundtrip),
//   * enqueueMessageJob is the single-id sugar over the batched form with
//     priority defaulting to the live lane (0),
//   * retryMessageJob resets a job to the head of the queue: pending,
//     attempt 0, lock cleared, next_run_at now.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

// Property accesses are deferred into method bodies so the hoisted factory
// never touches `fake` before its initializer runs.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

vi.mock("../log.server", () => ({
  logInfo: () => {},
  logError: () => {},
}));

import { enqueueMessageJob, enqueueMessageJobs, retryMessageJob } from "./enqueue";

const NOW_ISO = "2026-09-01T12:00:00.000Z";

function jobUpserts() {
  return fake.calls.upserts.filter((u) => u.table === "message_jobs");
}

beforeEach(() => {
  fake.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
});

describe("enqueueMessageJobs", () => {
  it("upserts pending rows with priority, published_at_ms, and staggered next_run_at", async () => {
    await enqueueMessageJobs("acc-1", "user-1", ["gm-0", "gm-1", "gm-2"], 10, {
      publishedAtMs: 1_700_000_000_000,
    });
    expect(jobUpserts()).toHaveLength(1);
    expect(jobUpserts()[0]!.payload).toEqual([
      {
        gmail_account_id: "acc-1",
        gmail_message_id: "gm-0",
        user_id: "user-1",
        status: "pending",
        priority: 10,
        next_run_at: "2026-09-01T12:00:00.000Z",
        published_at_ms: 1_700_000_000_000,
      },
      {
        gmail_account_id: "acc-1",
        gmail_message_id: "gm-1",
        user_id: "user-1",
        status: "pending",
        priority: 10,
        next_run_at: "2026-09-01T12:00:00.001Z", // idx-th ms — burst spread
        published_at_ms: 1_700_000_000_000,
      },
      {
        gmail_account_id: "acc-1",
        gmail_message_id: "gm-2",
        user_id: "user-1",
        status: "pending",
        priority: 10,
        next_run_at: "2026-09-01T12:00:00.002Z",
        published_at_ms: 1_700_000_000_000,
      },
    ]);
  });

  it("dedupes on (gmail_account_id, gmail_message_id) with ignoreDuplicates — re-enqueue is a no-op", async () => {
    await enqueueMessageJobs("acc-1", "user-1", ["gm-0"]);
    expect(jobUpserts()[0]!.options).toEqual({
      onConflict: "gmail_account_id,gmail_message_id",
      ignoreDuplicates: true,
    });
  });

  it("chunks large enqueues at 500 rows per upsert, wrapping the jitter slot at 500", async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `gm-${i}`);
    await enqueueMessageJobs("acc-1", "user-1", ids, 10);
    const sizes = jobUpserts().map((u) => (u.payload as unknown[]).length);
    expect(sizes).toEqual([500, 500, 1]);
    // Every chunk carries the same conflict/dedupe options.
    for (const u of jobUpserts()) {
      expect(u.options).toEqual({
        onConflict: "gmail_account_id,gmail_message_id",
        ignoreDuplicates: true,
      });
    }
    // idx % 500: row 500 lands on the same ms slot as row 0.
    const first = (jobUpserts()[0]!.payload as Array<Record<string, unknown>>)[0]!;
    const wrapped = (jobUpserts()[1]!.payload as Array<Record<string, unknown>>)[0]!;
    expect(wrapped.next_run_at).toBe(first.next_run_at);
    expect(wrapped.gmail_message_id).toBe("gm-500");
  });

  it("an empty id list is a no-op — no DB roundtrip", async () => {
    await enqueueMessageJobs("acc-1", "user-1", []);
    expect(jobUpserts()).toHaveLength(0);
  });

  it("throws the Supabase error on a failed chunk and aborts the remaining chunks", async () => {
    fake.onUpsert("message_jobs", () => ({ message: "db down" }));
    const ids = Array.from({ length: 600 }, (_, i) => `gm-${i}`);
    await expect(enqueueMessageJobs("acc-1", "user-1", ids)).rejects.toMatchObject({
      message: "db down",
    });
    // First chunk attempted, second never sent.
    expect(jobUpserts()).toHaveLength(1);
  });
});

describe("enqueueMessageJob", () => {
  it("delegates to the batched form with a single id and live-lane defaults", async () => {
    await enqueueMessageJob("acc-1", "user-1", "gm-solo");
    expect(jobUpserts()).toHaveLength(1);
    expect(jobUpserts()[0]!.payload).toEqual([
      {
        gmail_account_id: "acc-1",
        gmail_message_id: "gm-solo",
        user_id: "user-1",
        status: "pending",
        priority: 0, // live lane by default
        next_run_at: NOW_ISO,
        published_at_ms: null,
      },
    ]);
  });
});

describe("retryMessageJob", () => {
  it("resets the job to the head of the queue: pending, attempt 0, lock cleared", async () => {
    await retryMessageJob("job-9");
    const updates = fake.calls.updates.filter((u) => u.table === "message_jobs");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toEqual({
      status: "pending",
      attempt: 0,
      locked_at: null,
      next_run_at: NOW_ISO,
    });
    expect(updates[0]!.filters).toEqual([{ op: "eq", col: "id", value: "job-9" }]);
  });
});
