// Unit tests for runMessageJobs' core drain semantics — complements
// run-jobs-errors.test.ts (failure matrix, lane routing) and
// batch-ai-idempotency.test.ts (batch-pass idempotency gate). Contracts
// protected here:
//
//   * completion policy: an inline success DELETES the job row (jobs are
//     removed on success, never marked 'done'); batch-AI jobs are deleted
//     only in the second pass, after classification lands,
//   * claim protocol: the drain budget and priority lane are forwarded to
//     the claim_message_jobs RPC as p_limit/p_priority (p_priority omitted
//     when no lane is requested), and an empty claim result ends the tick
//     immediately — runMessageJobs is single-pass, the cron cadence is the
//     outer loop,
//   * lease handling: the drainer trusts the RPC's SKIP LOCKED + lease —
//     lock fields on CLAIMED rows are ignored; its own stuck-scan only
//     touches status='running' rows older than the 35s window,
//   * batching: AI-deferred jobs are grouped per account and chunked at
//     BATCH_SIZE=8 per classifyEmailsBatch call (7→[7], 8→[8], 9→[8,1]);
//     account context is loaded once per account; priority>=10 always
//     defers inline AI even for a single-job claim, but a backfill job
//     that needs no AI completes inline without a batch call,
//   * batch failure containment: a failed batch call falls back to
//     per-message classify; an individually-failed classify marks ONLY
//     that email unclassified — every job still deletes and counts ok, so
//     an AI outage can never DLQ or wedge the queue,
//   * per-job timeout: a hung processGmailMessage is raced against the
//     25s JOB_TIMEOUT_MS, requeued as a retryable failure (free retry —
//     attempt unchanged), and the worker moves on to the next job.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

// Property accesses are deferred into method bodies so the hoisted factory
// never touches `fake` before its initializer runs.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

vi.mock("../gmail.server", () => {
  class GmailApiError extends Error {
    status: number;
    retryable: boolean;
    retryAfterSeconds: number | null = null;
    isQuotaExceeded = false;
    constructor(message: string, status: number, retryable: boolean) {
      super(message);
      this.name = "GmailApiError";
      this.status = status;
      this.retryable = retryable;
    }
  }
  return { GmailApiError };
});

const classifyEmail = vi.fn();
const classifyEmailsBatch = vi.fn();
vi.mock("../ai.server", () => ({
  classifyEmail: (...args: unknown[]) => classifyEmail(...args),
  classifyEmailsBatch: (...args: unknown[]) => classifyEmailsBatch(...args),
}));

vi.mock("../log.server", () => ({
  logError: () => {},
  logInfo: () => {},
  newRunId: () => "test-run",
}));

// Context folders are configurable per test; loadAccountContext is a spy so
// per-account prefetch behavior can be asserted.
let ctxFolders: Array<Record<string, unknown>> = [];
const loadAccountContext = vi.fn(async (_accountId: string, _userId: string) => ({
  folders: ctxFolders,
  filters: [],
  overrides: [],
  overrideExceptions: [],
  enrichedFolders: ctxFolders.map((f) => ({ id: f.id, name: f.name })),
  calendarGuardEnabled: false,
  calendarContacts: new Set(),
  accountEmail: null,
  senderGroups: new Map(),
}));
vi.mock("./account-context", () => ({
  loadAccountContext: (accountId: string, userId: string) => loadAccountContext(accountId, userId),
}));

const updateEmailEncrypted = vi.fn(async (_input: unknown) => ({ error: null as string | null }));
vi.mock("./encrypted-writer", () => ({
  updateEmailEncrypted: (input: unknown) => updateEmailEncrypted(input),
}));

const bumpEmailsSinceLearn = vi.fn(async (_folderId: string) => {});
vi.mock("./folder-learn", () => ({
  bumpEmailsSinceLearn: (folderId: string) => bumpEmailsSinceLearn(folderId),
}));

const processGmailMessage = vi.fn();
const applyFolderActions = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./process-message", () => ({
  processGmailMessage: (...args: unknown[]) => processGmailMessage(...args),
  applyFolderActions: (...args: unknown[]) => applyFolderActions(...args),
}));

import { runMessageJobs } from "./run-jobs";

const ACC = "acc-1";
const USER = "user-1";

// Mirrors run-jobs.ts's JOB_TIMEOUT_MS (module-local constant).
const JOB_TIMEOUT_MS = 25_000;

type ClaimedJob = {
  id: string;
  gmail_account_id: string;
  gmail_message_id: string;
  user_id: string;
  attempt: number;
  priority: number;
  published_at_ms: number | null;
};

function job(over: Partial<ClaimedJob> & Record<string, unknown> = {}): ClaimedJob {
  return {
    id: "job-1",
    gmail_account_id: ACC,
    gmail_message_id: "gm-1",
    user_id: USER,
    attempt: 0,
    priority: 0,
    published_at_ms: null,
    ...over,
  };
}

function claim(jobs: ClaimedJob[]) {
  fake.onRpc("claim_message_jobs", () => jobs);
}

function folderA(over: Record<string, unknown> = {}) {
  return {
    id: "folder-A",
    name: "A",
    gmail_label_id: null,
    auto_archive: false,
    auto_mark_read: false,
    auto_star: false,
    hide_from_inbox: false,
    forward_to: null,
    snooze_hours: 0,
    min_ai_confidence: 0,
    ...over,
  };
}

const parsedStub = {
  raw_labels: ["INBOX"],
  subject: "hi",
  from_addr: "x@y.com",
  from_name: "X",
  received_at: "2026-07-19T00:00:00.000Z",
  body_text: "",
  snippet: "",
  body_html: "",
  to_addrs: "me@y.com",
  has_attachment: false,
};

function needsAiResult(emailRowId: string, subject = "hi") {
  return {
    id: emailRowId,
    email_id: emailRowId,
    folder_id: null,
    parsed: { ...parsedStub, subject },
    needs_ai: true,
  };
}

function jobUpdates() {
  return fake.calls.updates.filter((u) => u.table === "message_jobs");
}
function jobDeletes() {
  return fake.calls.deletes.filter((d) => d.table === "message_jobs");
}
function deletedJobIds(): string[] {
  return jobDeletes().map((d) =>
    String(d.filters.find((f) => f.op === "eq" && f.col === "id")?.value),
  );
}

/** Seed N backfill (priority=10) jobs whose emails rows are still pending,
 * wired so processGmailMessage returns the matching needs-AI result. */
function seedBackfillBatch(n: number): ClaimedJob[] {
  const jobs = Array.from({ length: n }, (_, i) =>
    job({ id: `job-${i}`, gmail_message_id: `gm-${i}`, priority: 10 }),
  );
  claim(jobs);
  fake.seed(
    "emails",
    jobs.map((j) => ({ id: `email-${j.id}`, classified_by: "pending_ai", folder_id: null })),
  );
  processGmailMessage.mockImplementation(async (_acc: string, gmailId: string) => {
    const idx = gmailId.split("-")[1];
    return needsAiResult(`email-job-${idx}`, gmailId);
  });
  return jobs;
}

beforeEach(() => {
  fake.reset();
  ctxFolders = [folderA()];
  classifyEmail.mockReset();
  classifyEmailsBatch.mockReset();
  loadAccountContext.mockClear();
  updateEmailEncrypted.mockClear();
  updateEmailEncrypted.mockResolvedValue({ error: null });
  bumpEmailsSinceLearn.mockClear();
  processGmailMessage.mockReset();
  applyFolderActions.mockClear();
});

describe("completion policy", () => {
  it("claim → process → success DELETES the job row (no terminal status write)", async () => {
    claim([job()]);
    // Message resolved by rules — a real result but nothing left for AI.
    processGmailMessage.mockResolvedValue({
      id: "e-1",
      email_id: "e-1",
      folder_id: "folder-A",
      needs_ai: false,
    });
    const summary = await runMessageJobs(10, 2);
    expect(summary).toEqual({ processed: 1, ok: 1, failed: 0, dlq: 0, retryable: 0 });
    expect(jobDeletes()).toHaveLength(1);
    expect(jobDeletes()[0]!.filters).toEqual([{ op: "eq", col: "id", value: "job-1" }]);
    // Success never mutates the row — it removes it.
    expect(jobUpdates()).toHaveLength(0);
    expect(classifyEmail).not.toHaveBeenCalled();
    expect(classifyEmailsBatch).not.toHaveBeenCalled();
  });
});

describe("failure containment: a job must never complete on someone else's failure", () => {
  it("releases the job when the account context could not be loaded, instead of deleting it", async () => {
    // Without a context the message would be classified against zero
    // folders and the job deleted, stranding the row at pending_ai.
    claim([job()]);
    loadAccountContext.mockRejectedValueOnce(new Error("db down"));
    const summary = await runMessageJobs(10, 2);
    expect(summary).toMatchObject({ processed: 1, ok: 0, retryable: 1 });
    expect(processGmailMessage).not.toHaveBeenCalled();
    expect(jobDeletes()).toHaveLength(0);
    expect(jobUpdates()).toHaveLength(1);
    expect(jobUpdates()[0]!.payload).toMatchObject({
      status: "pending",
      locked_at: null,
      last_error: "account_context_unavailable",
    });
  });

  it("releases the job when the batch-AI persist fails, instead of deleting it", async () => {
    const jobs = seedBackfillBatch(1);
    classifyEmailsBatch.mockResolvedValue([
      { folder_id: "folder-A", confidence: 0.99, summary: "s", reason: "r" },
    ]);
    updateEmailEncrypted.mockResolvedValue({ error: "encrypt rpc failed" });
    const summary = await runMessageJobs(10, 2);
    expect(summary).toMatchObject({ ok: 0, retryable: 1 });
    expect(deletedJobIds()).not.toContain(jobs[0]!.id);
    expect(jobUpdates()[0]!.payload).toMatchObject({
      status: "pending",
      locked_at: null,
      last_error: expect.stringContaining("batch_ai_persist_failed"),
    });
  });

  it("releases the job when the per-message fallback persist fails", async () => {
    const jobs = seedBackfillBatch(1);
    classifyEmailsBatch.mockRejectedValue(new Error("gateway down"));
    classifyEmail.mockResolvedValue({
      folder_id: "folder-A",
      confidence: 0.9,
      summary: "s",
      reason: "r",
    });
    updateEmailEncrypted.mockResolvedValue({ error: "encrypt rpc failed" });
    await runMessageJobs(10, 2);
    expect(deletedJobIds()).not.toContain(jobs[0]!.id);
    expect(jobUpdates()[0]!.payload).toMatchObject({
      last_error: expect.stringContaining("batch_ai_fallback_persist_failed"),
    });
  });

  it("never persists a folder id the model invented (not in the candidate set)", async () => {
    seedBackfillBatch(1);
    classifyEmailsBatch.mockResolvedValue([
      { folder_id: "folder-HALLUCINATED", confidence: 0.99, summary: "s", reason: "r" },
    ]);
    await runMessageJobs(10, 2);
    expect(updateEmailEncrypted).toHaveBeenCalledTimes(1);
    const payload = updateEmailEncrypted.mock.calls[0]![0] as Record<string, unknown>;
    // Treated as "no folder": an unknown id has no min_ai_confidence to
    // check against, so it used to sail through at threshold 0.
    expect(payload.folder_id).toBeNull();
    expect(payload.classified_by).toBe("ai");
    expect(applyFolderActions).not.toHaveBeenCalled();
    expect(bumpEmailsSinceLearn).not.toHaveBeenCalled();
  });

  it("leaves no pending timers behind: the per-job timeout is cleared when the job wins", async () => {
    vi.useFakeTimers();
    try {
      claim([job({ id: "job-1" }), job({ id: "job-2", gmail_message_id: "gm-2" })]);
      processGmailMessage.mockResolvedValue({
        id: "e-1",
        email_id: "e-1",
        folder_id: "folder-A",
        needs_ai: false,
      });
      await runMessageJobs(10, 2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("claim protocol", () => {
  it("forwards the drain budget and priority lane to claim_message_jobs", async () => {
    claim([]);
    await runMessageJobs(42, 2, { priority: 10 });
    await runMessageJobs(7, 2); // no lane requested
    const rpcs = fake.calls.rpcs.filter((r) => r.fn === "claim_message_jobs");
    expect(rpcs).toHaveLength(2);
    expect(rpcs[0]!.args.p_limit).toBe(42);
    expect(rpcs[0]!.args.p_priority).toBe(10);
    expect(rpcs[1]!.args.p_limit).toBe(7);
    // Undefined lane → the RPC's own default ordering applies.
    expect(rpcs[1]!.args.p_priority).toBeUndefined();
  });

  it("an empty claim ends the tick: zero summary, no processing, no context prefetch", async () => {
    claim([]);
    const summary = await runMessageJobs(10, 2);
    expect(summary).toEqual({ processed: 0, ok: 0, failed: 0, dlq: 0, retryable: 0 });
    expect(processGmailMessage).not.toHaveBeenCalled();
    expect(loadAccountContext).not.toHaveBeenCalled();
    expect(jobDeletes()).toHaveLength(0);
    expect(jobUpdates()).toHaveLength(0);
  });
});

describe("lease handling", () => {
  it("ignores lock fields on CLAIMED rows — lease enforcement lives in the RPC", async () => {
    // The RPC hands back whatever it claimed; even if the row carries a
    // stale locked_at, the drainer processes it without any reclaim write.
    const staleLock = new Date(Date.now() - 300_000).toISOString();
    claim([job({ status: "running", locked_at: staleLock })]);
    processGmailMessage.mockResolvedValue({ skipped: true });
    const summary = await runMessageJobs(10, 2);
    expect(summary).toMatchObject({ processed: 1, ok: 1 });
    expect(deletedJobIds()).toEqual(["job-1"]);
    expect(jobUpdates()).toHaveLength(0);
  });

  it("the stuck-scan leaves a 'running' row inside the 35s window untouched", async () => {
    fake.seed("message_jobs", [
      {
        id: "fresh-1",
        status: "running",
        locked_at: new Date(Date.now() - 10_000).toISOString(),
        attempt: 0,
        last_error: null,
      },
    ]);
    claim([]);
    await runMessageJobs(10, 2);
    // Not reclaimed: another worker is still legitimately inside its lease.
    expect(jobUpdates()).toHaveLength(0);
  });
});

describe("batch AI pass", () => {
  it.each<[number, number[]]>([
    [7, [7]],
    [8, [8]],
    [9, [8, 1]],
  ])("%d pending AI jobs are chunked into batches of %j", async (n, expectedChunks) => {
    seedBackfillBatch(n);
    classifyEmailsBatch.mockImplementation(async (items: unknown[]) =>
      items.map(() => ({ folder_id: "folder-A", confidence: 0.95, summary: "s", reason: "r" })),
    );

    const summary = await runMessageJobs(100, 4);
    expect(summary).toMatchObject({ processed: n, ok: n, failed: 0, dlq: 0 });
    expect(classifyEmailsBatch.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual(
      expectedChunks,
    );
    // Inline AI never runs on the backfill lane.
    expect(classifyEmail).not.toHaveBeenCalled();
    // Every job is finalized (folder applied, row persisted, job deleted)
    // only via the batch pass.
    expect(applyFolderActions).toHaveBeenCalledTimes(n);
    expect(updateEmailEncrypted).toHaveBeenCalledTimes(n);
    expect(jobDeletes()).toHaveLength(n);
  });

  it("groups the pass per account and loads context once per account", async () => {
    const jobs = [
      job({ id: "job-a1", gmail_account_id: "acc-1", gmail_message_id: "gm-a1", priority: 10 }),
      job({ id: "job-a2", gmail_account_id: "acc-1", gmail_message_id: "gm-a2", priority: 10 }),
      job({ id: "job-b1", gmail_account_id: "acc-2", gmail_message_id: "gm-b1", priority: 10 }),
      job({ id: "job-b2", gmail_account_id: "acc-2", gmail_message_id: "gm-b2", priority: 10 }),
      job({ id: "job-b3", gmail_account_id: "acc-2", gmail_message_id: "gm-b3", priority: 10 }),
    ];
    claim(jobs);
    fake.seed(
      "emails",
      jobs.map((j) => ({ id: `email-${j.id}`, classified_by: "pending_ai", folder_id: null })),
    );
    processGmailMessage.mockImplementation(async (_acc: string, gmailId: string) =>
      needsAiResult(`email-job-${gmailId.slice(3)}`, gmailId),
    );
    classifyEmailsBatch.mockImplementation(async (items: unknown[]) =>
      items.map(() => ({ folder_id: "folder-A", confidence: 0.95, summary: "s", reason: "r" })),
    );

    const summary = await runMessageJobs(100, 4);
    expect(summary).toMatchObject({ processed: 5, ok: 5 });
    // One prefetch per distinct account, not per job.
    expect(loadAccountContext).toHaveBeenCalledTimes(2);
    expect(loadAccountContext.mock.calls.map((c) => c[0]).sort()).toEqual(["acc-1", "acc-2"]);
    // One batch call per account (both under BATCH_SIZE): sizes 2 and 3.
    expect(classifyEmailsBatch.mock.calls.map((c) => (c[0] as unknown[]).length).sort()).toEqual([
      2, 3,
    ]);
    // priority>=10 always defers the inline AI step, even in a small claim.
    for (const call of processGmailMessage.mock.calls) {
      expect(call[3]).toMatchObject({ skipAi: true });
    }
    expect(jobDeletes()).toHaveLength(5);
  });

  it("a backfill job that needs no AI completes inline — no batch call", async () => {
    claim([job({ priority: 10 })]);
    processGmailMessage.mockResolvedValue({
      id: "e-1",
      email_id: "e-1",
      folder_id: "folder-A",
      needs_ai: false,
    });
    const summary = await runMessageJobs(10, 2);
    expect(summary).toMatchObject({ processed: 1, ok: 1 });
    expect(processGmailMessage.mock.calls[0]![3]).toMatchObject({ skipAi: true });
    expect(classifyEmailsBatch).not.toHaveBeenCalled();
    expect(deletedJobIds()).toEqual(["job-1"]);
  });

  it("batch failure falls back per-message; only the failed email is marked unclassified", async () => {
    seedBackfillBatch(2); // gm-0 → email-job-0, gm-1 → email-job-1
    classifyEmailsBatch.mockRejectedValue(new Error("LLM 500"));
    classifyEmail.mockImplementation(async (parsed: { subject: string }) => {
      if (parsed.subject === "gm-1") throw new Error("single classify exploded");
      return { folder_id: "folder-A", confidence: 0.9, summary: "s", reason: "r" };
    });

    const summary = await runMessageJobs(10, 2);
    // AI failures never fail the JOB — both delete and count ok, so an AI
    // outage cannot DLQ messages or wedge the queue.
    expect(summary).toMatchObject({ processed: 2, ok: 2, failed: 0, dlq: 0, retryable: 0 });
    const updates = updateEmailEncrypted.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(updates.find((u) => u.email_id === "email-job-0")).toMatchObject({
      classified_by: "ai",
      folder_id: "folder-A",
    });
    expect(updates.find((u) => u.email_id === "email-job-1")).toMatchObject({
      classified_by: "unclassified",
      classification_reason: "AI classifier failed: single classify exploded",
    });
    expect(updates).toHaveLength(2);
    // Only the successfully-classified email gets folder side-effects.
    expect(applyFolderActions).toHaveBeenCalledTimes(1);
    expect(new Set(deletedJobIds())).toEqual(new Set(["job-0", "job-1"]));
  });
});

describe("per-job timeout", () => {
  it("a hung job is timed out, requeued retryable, and the drain continues", async () => {
    vi.useFakeTimers();
    claim([
      job({ id: "job-hang", gmail_message_id: "gm-hang" }),
      job({ id: "job-ok", gmail_message_id: "gm-ok" }),
    ]);
    processGmailMessage.mockImplementation(async (_acc: string, gmailId: string) => {
      if (gmailId === "gm-hang") return new Promise(() => {}); // never settles
      return { skipped: true };
    });

    // concurrency=1: job-ok is reachable ONLY if the timeout releases the
    // worker — this proves a hang can't wedge the drain.
    const drain = runMessageJobs(10, 1);
    await vi.advanceTimersByTimeAsync(JOB_TIMEOUT_MS);
    const summary = await drain;

    expect(summary).toMatchObject({ processed: 2, ok: 1, failed: 1, retryable: 1, dlq: 0 });
    // The hung job is requeued with the timeout error; a timeout matches the
    // retryable regex and the first retryable failures are free, so attempt
    // stays 0 and the row goes back to pending with its lock cleared.
    const upd = jobUpdates().find((u) =>
      u.filters.some((f) => f.op === "eq" && f.col === "id" && f.value === "job-hang"),
    );
    expect(upd).toBeDefined();
    expect(upd!.payload).toMatchObject({ status: "pending", attempt: 0, locked_at: null });
    expect(String((upd!.payload as Record<string, unknown>).last_error)).toMatch(
      /^job timeout after 25000ms/,
    );
    // The healthy job behind it still completed.
    expect(deletedJobIds()).toEqual(["job-ok"]);
  });
});
