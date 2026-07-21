// Unit tests for the three backfill entry points. Contracts:
//
//   backfillRecent — 30d bootstrap query, enqueue at priority 0 (live lane);
//     an enqueue failure is reported in the return shape, never thrown.
//   backfillWindow — pages Gmail with maxResults=min(100, remaining) up to
//     the cap, de-dupes IDs across pages, drops already-stored IDs in 500-id
//     chunks, processes with skipPush (backfill must not fire notifications)
//     and counts per-message failures without aborting.
//   startBackfillJob — reuses an active job, clamps months to [1, 120], and
//     anchors the query at a stable UTC after:YYYY/MM/DD date (newer_than:Nd
//     would drift across ticks).
//   tickBackfillJobs — listing enqueues at priority 10 (backfill lane),
//     stops at the per-tick page cap persisting next_page_token, flips
//     listing→processing when Gmail runs out, processing→done only when the
//     account's queue is drained (else "draining"), and a job error is
//     recorded on the row without failing the tick.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import { BACKFILL_LIST_PAGES_PER_TICK, BACKFILL_PAGE_SIZE } from "./config";

const fake = makeSupabaseFake();

// Property accesses are deferred into method bodies so the hoisted factory
// never touches `fake` before its initializer runs.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

const listMessages = vi.fn();
vi.mock("../gmail.server", () => ({
  listMessages: (accountId: string, opts: unknown) => listMessages(accountId, opts),
}));

const enqueueMessageJobs = vi.fn();
vi.mock("./enqueue", () => ({
  enqueueMessageJobs: (...args: unknown[]) => enqueueMessageJobs(...args),
}));

const processGmailMessage = vi.fn();
vi.mock("./process-message", () => ({
  processGmailMessage: (...args: unknown[]) => processGmailMessage(...args),
}));

const logError = vi.fn();
vi.mock("../log.server", () => ({
  logError: (...args: unknown[]) => logError(...args),
  logInfo: () => {},
}));

import { backfillRecent, backfillWindow, startBackfillJob, tickBackfillJobs } from "./backfill";

const ACC = "acc-1";
const USER = "user-1";

function msgs(...ids: string[]) {
  return ids.map((id) => ({ id, threadId: `t-${id}` }));
}

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  listMessages.mockResolvedValue({ messages: [] });
  enqueueMessageJobs.mockResolvedValue(undefined);
  processGmailMessage.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("backfillRecent", () => {
  it("lists the last 30 days and enqueues at priority 0 (live lane)", async () => {
    listMessages.mockResolvedValueOnce({ messages: msgs("m1", "m2") });
    const res = await backfillRecent(ACC, USER, 50);
    expect(listMessages).toHaveBeenCalledWith(ACC, {
      maxResults: 50,
      q: "-in:chats -in:trash -in:spam newer_than:30d",
    });
    expect(enqueueMessageJobs).toHaveBeenCalledWith(ACC, USER, ["m1", "m2"], 0);
    expect(res).toEqual({ processed: 2, enqueued: 2 });
  });

  it("returns the error shape instead of throwing when the enqueue fails", async () => {
    listMessages.mockResolvedValueOnce({ messages: msgs("m1") });
    enqueueMessageJobs.mockRejectedValueOnce(new Error("db down"));
    const res = await backfillRecent(ACC, USER);
    expect(res).toEqual({ processed: 0, enqueued: 0, error: "db down" });
    expect(logError).toHaveBeenCalledWith(
      "sync.backfill_recent_enqueue_failed",
      expect.objectContaining({ account_id: ACC, candidate_count: 1 }),
      expect.any(Error),
    );
  });
});

describe("backfillWindow", () => {
  it("caps at maxMessages and sizes each page request to min(100, remaining)", async () => {
    listMessages
      .mockResolvedValueOnce({ messages: msgs("m1", "m2", "m3"), nextPageToken: "t2" })
      .mockResolvedValueOnce({ messages: msgs("m4", "m5"), nextPageToken: "t3" });

    const res = await backfillWindow(ACC, USER, { query: "newer_than:7d", maxMessages: 5 });
    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(listMessages).toHaveBeenNthCalledWith(1, ACC, {
      q: "newer_than:7d",
      maxResults: 5,
      pageToken: undefined,
    });
    expect(listMessages).toHaveBeenNthCalledWith(2, ACC, {
      q: "newer_than:7d",
      maxResults: 2,
      pageToken: "t2",
    });
    expect(res).toMatchObject({ found: 5, processed: 5, failed: 0 });
  });

  it("de-dupes message IDs repeated across pages", async () => {
    listMessages
      .mockResolvedValueOnce({ messages: msgs("m1", "m2"), nextPageToken: "t2" })
      .mockResolvedValueOnce({ messages: msgs("m2", "m3") });

    const res = await backfillWindow(ACC, USER, { query: "q", maxMessages: 10 });
    expect(res).toMatchObject({ found: 3, processed: 3 });
    expect(processGmailMessage).toHaveBeenCalledTimes(3);
  });

  it("drops already-stored IDs in 500-id chunks and processes the rest with skipPush", async () => {
    // 600 IDs across 6 pages of 100 → two dedupe chunks (500 + 100).
    const all = Array.from({ length: 600 }, (_, i) => `id-${i}`);
    for (let p = 0; p < 6; p++) {
      listMessages.mockResolvedValueOnce({
        messages: msgs(...all.slice(p * 100, (p + 1) * 100)),
        nextPageToken: p < 5 ? `t${p + 1}` : undefined,
      });
    }
    fake.seed("emails", [
      { gmail_account_id: ACC, gmail_message_id: "id-0" },
      { gmail_account_id: ACC, gmail_message_id: "id-599" },
    ]);

    const res = await backfillWindow(ACC, USER, { query: "q", maxMessages: 600 });
    expect(res).toMatchObject({ found: 600, alreadyHad: 2, processed: 598, failed: 0 });

    const dedupeSelects = fake.calls.selects.filter((s) => s.table === "emails");
    expect(dedupeSelects).toHaveLength(2);
    const inSizes = dedupeSelects.map(
      (s) => (s.filters.find((f) => f.op === "in")?.value as string[]).length,
    );
    expect(inSizes).toEqual([500, 100]);

    // Every processed message goes through with skipPush — backfilled mail
    // must never fire push notifications.
    expect(processGmailMessage).toHaveBeenCalledTimes(598);
    expect(processGmailMessage).toHaveBeenCalledWith(ACC, "id-1", USER, { skipPush: true });
    expect(processGmailMessage).not.toHaveBeenCalledWith(ACC, "id-0", USER, { skipPush: true });
  });

  it("counts per-message failures without aborting the rest", async () => {
    listMessages.mockResolvedValueOnce({ messages: msgs("m1", "m2", "m3") });
    processGmailMessage.mockImplementation(async (_acc, id) => {
      if (id === "m2") throw new Error("parse blew up");
    });

    const res = await backfillWindow(ACC, USER, { query: "q", concurrency: 1 });
    expect(res).toMatchObject({ found: 3, processed: 2, failed: 1 });
    expect(logError).toHaveBeenCalledWith(
      "sync.backfill_window_process_failed",
      expect.objectContaining({ gmail_message_id: "m2" }),
      expect.any(Error),
    );
  });
});

describe("startBackfillJob", () => {
  it("reuses an active job for the account instead of inserting a new one", async () => {
    fake.seed("backfill_jobs", [{ id: "job-1", gmail_account_id: ACC, status: "listing" }]);
    const res = await startBackfillJob(ACC, USER, { months: 6 });
    expect(res).toEqual({ job_id: "job-1", reused: true });
    expect(fake.calls.inserts).toHaveLength(0);
  });

  it("clamps months to [1, 120] and anchors the query at a stable UTC after: date", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-15T12:00:00Z"), toFake: ["Date"] });

    await startBackfillJob(ACC, USER, { months: 0 });
    await startBackfillJob(ACC, USER, { months: 999 });

    expect(fake.calls.inserts).toHaveLength(2);
    expect(fake.calls.inserts[0].payload).toEqual({
      user_id: USER,
      gmail_account_id: ACC,
      query: "after:2026/06/15 -in:chats -in:trash -in:spam",
      months: 1,
      status: "listing",
    });
    expect(fake.calls.inserts[1].payload).toEqual(
      expect.objectContaining({
        months: 120,
        query: "after:2016/09/05 -in:chats -in:trash -in:spam",
      }),
    );
  });
});

describe("tickBackfillJobs", () => {
  function seedListingJob(overrides: Record<string, unknown> = {}) {
    fake.seed("backfill_jobs", [
      {
        id: "job-1",
        user_id: USER,
        gmail_account_id: ACC,
        query: "after:2026/01/01 -in:chats -in:trash -in:spam",
        status: "listing",
        next_page_token: null,
        total_found: 10,
        total_enqueued: 7,
        already_had: 3,
        updated_at: "2026-07-01T00:00:00Z",
        ...overrides,
      },
    ]);
  }

  it("enqueues deduped IDs at priority 10 and flips to processing when Gmail runs out", async () => {
    seedListingJob();
    listMessages.mockResolvedValueOnce({ messages: msgs("m1", "m2") });
    fake.seed("emails", [{ gmail_account_id: ACC, gmail_message_id: "m1" }]);

    const res = await tickBackfillJobs();
    expect(res.processed).toBe(1);
    expect(res.results[0]).toEqual({ job_id: "job-1", phase: "listed", added: 1 });
    expect(listMessages).toHaveBeenCalledWith(ACC, {
      q: "after:2026/01/01 -in:chats -in:trash -in:spam",
      maxResults: BACKFILL_PAGE_SIZE,
      pageToken: undefined,
    });
    expect(enqueueMessageJobs).toHaveBeenCalledWith(ACC, USER, ["m2"], 10);

    const jobUpdates = fake.calls.updates.filter((u) => u.table === "backfill_jobs");
    expect(jobUpdates).toHaveLength(1);
    expect(jobUpdates[0].payload).toEqual({
      next_page_token: null,
      total_found: 12,
      total_enqueued: 8,
      already_had: 4,
      status: "processing",
    });
  });

  it("stops at the per-tick page cap and persists next_page_token while still listing", async () => {
    seedListingJob();
    let page = 0;
    listMessages.mockImplementation(async () => {
      page++;
      return { messages: msgs(`p${page}`), nextPageToken: `tok-${page}` };
    });

    const res = await tickBackfillJobs();
    expect(listMessages).toHaveBeenCalledTimes(BACKFILL_LIST_PAGES_PER_TICK);
    expect(res.results[0]).toEqual({
      job_id: "job-1",
      phase: "listing",
      added: BACKFILL_LIST_PAGES_PER_TICK,
    });
    const jobUpdates = fake.calls.updates.filter((u) => u.table === "backfill_jobs");
    expect(jobUpdates[0].payload).toMatchObject({
      status: "listing",
      next_page_token: `tok-${BACKFILL_LIST_PAGES_PER_TICK}`,
      total_found: 10 + BACKFILL_LIST_PAGES_PER_TICK,
    });
  });

  it("marks a processing job done only when the account's queue is drained (dlq rows do not count)", async () => {
    seedListingJob({ status: "processing" });
    // Only a DLQ row remains — the drain check excludes dlq → done.
    fake.seed("message_jobs", [{ id: "j-dead", gmail_account_id: ACC, status: "dlq" }]);
    const res = await tickBackfillJobs();
    expect(res.results[0]).toEqual({ job_id: "job-1", phase: "done" });
    const jobUpdates = fake.calls.updates.filter((u) => u.table === "backfill_jobs");
    expect(jobUpdates).toHaveLength(1);
    expect(jobUpdates[0].payload).toMatchObject({ status: "done" });
    expect(jobUpdates[0].payload).toHaveProperty("finished_at");
  });

  it("reports draining and touches updated_at while jobs remain", async () => {
    seedListingJob({ status: "processing" });
    fake.seed("message_jobs", [{ id: "j1", gmail_account_id: ACC, status: "pending" }]);

    const res = await tickBackfillJobs();
    expect(res.results[0]).toEqual({ job_id: "job-1", phase: "draining" });
    const jobUpdates = fake.calls.updates.filter((u) => u.table === "backfill_jobs");
    expect(jobUpdates).toHaveLength(1);
    expect(Object.keys(jobUpdates[0].payload as Record<string, unknown>)).toEqual(["updated_at"]);
  });

  it("records a job error on the row and keeps the tick alive", async () => {
    seedListingJob();
    listMessages.mockRejectedValue(new Error("Gmail API error 500"));

    const res = await tickBackfillJobs();
    expect(res.results[0]).toEqual({
      job_id: "job-1",
      phase: "error",
      error: "Gmail API error 500",
    });
    const jobUpdates = fake.calls.updates.filter((u) => u.table === "backfill_jobs");
    expect(jobUpdates).toHaveLength(1);
    expect(jobUpdates[0].payload).toEqual({ last_error: "Gmail API error 500" });
    expect(logError).toHaveBeenCalledWith(
      "sync.tick_backfill_job_failed",
      expect.objectContaining({ job_id: "job-1" }),
      expect.any(Error),
    );
  });
});
