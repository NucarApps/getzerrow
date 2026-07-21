// Unit tests for runMessageJobs' failure handling and lane routing —
// complements batch-ai-idempotency.test.ts (which covers the batch pass's
// idempotency gate). Contracts protected here:
//
//   * stuck-job reclaim burns an attempt only on the SECOND consecutive
//     reclaim (marker match), and DLQs once attempts are exhausted,
//   * a claim RPC failure returns a summary — the cron tick never throws,
//   * the handleError matrix: 404 = job done, bare 401/403 = immediate DLQ,
//     but a quota/rate-limit 403 is retried (gmail.server marks it retryable),
//     retryable failures get RETRYABLE_FREE_ATTEMPTS free retries,
//     Retry-After drives the backoff, DLQ rows carry only the truncated
//     error (no decrypted subject/sender — plaintext must never land in
//     message_jobs),
//   * a failed job's stuck 'pending' email row is finalized to ai_error
//     via the encrypted writer,
//   * deferAiToCron requeues instead of classifying inline,
//   * live bursts >= LIVE_BATCH_AI_THRESHOLD route AI through the batched
//     classifier; small claims stay inline,
//   * the batch pass honors each folder's min_ai_confidence.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import { MAX_JOB_ATTEMPTS, RETRYABLE_FREE_ATTEMPTS } from "./backoff";
import { LIVE_BATCH_AI_THRESHOLD, WEBHOOK_DEFERRED_AI_REQUEUE_MS } from "./config";

const fake = makeSupabaseFake();

// Property accesses are deferred into method bodies so the hoisted factory
// never touches `fake` before its initializer runs.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

vi.mock("../gmail.server", () => {
  class GmailApiError extends Error {
    status: number;
    retryable: boolean;
    retryAfterSeconds: number | null;
    isQuotaExceeded: boolean;
    constructor(
      message: string,
      status: number,
      retryable: boolean,
      opts: { retryAfterSeconds?: number | null; isQuotaExceeded?: boolean } = {},
    ) {
      super(message);
      this.name = "GmailApiError";
      this.status = status;
      this.retryable = retryable;
      this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
      this.isQuotaExceeded = opts.isQuotaExceeded ?? false;
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

// Context folders are configurable per test (min_ai_confidence gating).
let ctxFolders: Array<Record<string, unknown>> = [];
vi.mock("./account-context", () => ({
  async loadAccountContext() {
    return {
      folders: ctxFolders,
      filters: [],
      overrides: [],
      overrideExceptions: [],
      enrichedFolders: ctxFolders.map((f) => ({ id: f.id, name: f.name })),
      calendarGuardEnabled: false,
      calendarContacts: new Set(),
      accountEmail: null,
      senderGroups: new Map(),
    };
  },
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

import { GmailApiError } from "../gmail.server";
import { runMessageJobs } from "./run-jobs";

const ACC = "acc-1";
const USER = "user-1";

type ClaimedJob = {
  id: string;
  gmail_account_id: string;
  gmail_message_id: string;
  user_id: string;
  attempt: number;
  priority: number;
  published_at_ms: number | null;
};

function job(over: Partial<ClaimedJob> = {}): ClaimedJob {
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

function needsAiResult(emailRowId: string) {
  return {
    id: emailRowId,
    email_id: emailRowId,
    folder_id: null,
    parsed: parsedStub,
    needs_ai: true,
  };
}

function jobUpdates() {
  return fake.calls.updates.filter((u) => u.table === "message_jobs");
}
function jobDeletes() {
  return fake.calls.deletes.filter((d) => d.table === "message_jobs");
}

beforeEach(() => {
  fake.reset();
  ctxFolders = [folderA()];
  classifyEmail.mockReset();
  classifyEmailsBatch.mockReset();
  updateEmailEncrypted.mockClear();
  updateEmailEncrypted.mockResolvedValue({ error: null });
  bumpEmailsSinceLearn.mockClear();
  processGmailMessage.mockReset();
  applyFolderActions.mockClear();
});

describe("stuck-job reclaim", () => {
  const oldLock = new Date(Date.now() - 60_000).toISOString();

  it("first reclaim (no marker) requeues WITHOUT burning an attempt", async () => {
    fake.seed("message_jobs", [
      { id: "stuck-1", status: "running", locked_at: oldLock, attempt: 2, last_error: "boom" },
    ]);
    await runMessageJobs(10, 2);
    expect(jobUpdates()).toHaveLength(1);
    expect(jobUpdates()[0].payload).toMatchObject({
      status: "pending",
      attempt: 2, // unchanged — one accidental worker kill is free
      last_error: "stuck (worker timeout) — auto-reclaimed",
      locked_at: null,
    });
    expect(jobUpdates()[0].filters).toEqual([{ op: "eq", col: "id", value: "stuck-1" }]);
  });

  it("second consecutive reclaim (marker present) burns an attempt", async () => {
    fake.seed("message_jobs", [
      {
        id: "stuck-1",
        status: "running",
        locked_at: oldLock,
        attempt: 2,
        last_error: "stuck (worker timeout) — auto-reclaimed",
      },
    ]);
    await runMessageJobs(10, 2);
    expect(jobUpdates()[0].payload).toMatchObject({ status: "pending", attempt: 3 });
  });

  it("DLQs a repeatedly-stuck job once attempts reach MAX_JOB_ATTEMPTS", async () => {
    fake.seed("message_jobs", [
      {
        id: "stuck-1",
        status: "running",
        locked_at: oldLock,
        attempt: MAX_JOB_ATTEMPTS - 1,
        last_error: "stuck (worker timeout) — auto-reclaimed",
      },
    ]);
    await runMessageJobs(10, 2);
    expect(jobUpdates()[0].payload).toMatchObject({
      status: "dlq",
      attempt: MAX_JOB_ATTEMPTS,
      last_error: "stuck (worker timeout — exceeded max attempts)",
      locked_at: null,
    });
  });
});

describe("claim failures", () => {
  it("returns an error summary instead of throwing when the claim RPC fails", async () => {
    fake.onRpc("claim_message_jobs", () => ({ error: { message: "rpc down" } }));
    const summary = await runMessageJobs(10, 2);
    expect(summary).toEqual({
      processed: 0,
      ok: 0,
      failed: 0,
      dlq: 0,
      retryable: 0,
      error: "rpc down",
    });
  });
});

describe("handleError matrix", () => {
  it("404 deletes the job and counts it as ok (message gone in Gmail)", async () => {
    claim([job()]);
    processGmailMessage.mockRejectedValue(new GmailApiError("gone", 404, false));
    const summary = await runMessageJobs(10, 2);
    expect(summary).toMatchObject({ processed: 1, ok: 1, dlq: 0, failed: 0 });
    expect(jobDeletes()).toHaveLength(1);
    expect(jobDeletes()[0].filters).toEqual([{ op: "eq", col: "id", value: "job-1" }]);
    expect(jobUpdates()).toHaveLength(0);
  });

  it("finalizes the stuck 'pending' email row to ai_error via the encrypted writer", async () => {
    claim([job()]);
    fake.seed("emails", [
      { id: "e-9", gmail_account_id: ACC, gmail_message_id: "gm-1", classified_by: "pending" },
    ]);
    const longMsg = "x".repeat(400);
    processGmailMessage.mockRejectedValue(new Error(longMsg));
    await runMessageJobs(10, 2);
    expect(updateEmailEncrypted).toHaveBeenCalledTimes(1);
    const arg = updateEmailEncrypted.mock.calls[0][0] as {
      email_id: string;
      classified_by: string;
      classification_reason: string;
    };
    expect(arg.email_id).toBe("e-9");
    expect(arg.classified_by).toBe("ai_error");
    // Reason is truncated to 300 chars of the error.
    expect(arg.classification_reason).toBe(`Worker error: ${"x".repeat(300)}`);
  });

  it("401 is terminal: immediate DLQ with attempt+1 and the error truncated to 1000 chars", async () => {
    claim([job({ attempt: 0 })]);
    const longMsg = "auth ".repeat(400); // 2000 chars
    processGmailMessage.mockRejectedValue(new GmailApiError(longMsg, 401, false));
    const summary = await runMessageJobs(10, 2);
    expect(summary).toMatchObject({ processed: 1, ok: 0, dlq: 1 });
    expect(jobUpdates()).toHaveLength(1);
    const payload = jobUpdates()[0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({ status: "dlq", attempt: 1, locked_at: null });
    // Only the truncated error message is persisted — never decrypted
    // subject/sender plaintext.
    expect(payload.last_error).toBe(longMsg.slice(0, 1000));
    expect(jobDeletes()).toHaveLength(0);
  });

  it("a bare 403 (non-retryable auth/permission failure) is terminal: immediate DLQ", async () => {
    claim([job({ attempt: 0 })]);
    processGmailMessage.mockRejectedValue(new GmailApiError("insufficient permission", 403, false));
    const summary = await runMessageJobs(10, 2);
    expect(summary).toMatchObject({ processed: 1, ok: 0, dlq: 1 });
    expect(jobUpdates()[0].payload).toMatchObject({ status: "dlq", attempt: 1 });
  });

  it("a quota/rate-limit 403 is retried, NOT dead-lettered", async () => {
    // Gmail returns per-user throttling as 403 as well as 429; gmail.server
    // marks those retryable. run-jobs must route them through backoff, or a
    // brief quota blip would permanently DLQ otherwise-healthy messages.
    claim([job({ attempt: 0 })]);
    processGmailMessage.mockRejectedValue(
      new GmailApiError("Gmail API 403: userRateLimitExceeded", 403, true, {
        isQuotaExceeded: false,
      }),
    );
    const summary = await runMessageJobs(10, 2);
    expect(summary).toMatchObject({ processed: 1, ok: 0, retryable: 1, dlq: 0 });
    expect(jobUpdates()[0].payload).toMatchObject({ status: "pending", attempt: 0 });
  });

  it("a daily-quota 403 (isQuotaExceeded) is also retried rather than DLQ'd", async () => {
    claim([job({ attempt: 0 })]);
    processGmailMessage.mockRejectedValue(
      new GmailApiError("Gmail API 403: dailyLimitExceeded", 403, true, { isQuotaExceeded: true }),
    );
    const summary = await runMessageJobs(10, 2);
    expect(summary).toMatchObject({ processed: 1, ok: 0, dlq: 0 });
    expect(jobUpdates()[0].payload).toMatchObject({ status: "pending" });
  });

  it("retryable 429 under RETRYABLE_FREE_ATTEMPTS keeps attempt unchanged and honors Retry-After", async () => {
    expect(RETRYABLE_FREE_ATTEMPTS).toBeGreaterThan(0);
    claim([job({ attempt: 0 })]);
    processGmailMessage.mockRejectedValue(
      new GmailApiError("rate limited", 429, true, { retryAfterSeconds: 120 }),
    );
    const before = Date.now();
    const summary = await runMessageJobs(10, 2);
    expect(summary).toMatchObject({ processed: 1, ok: 0, failed: 1, retryable: 1, dlq: 0 });
    const payload = jobUpdates()[0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({ status: "pending", attempt: 0, locked_at: null });
    // Retry-After 120s → jitter → 90–150s from now.
    const nextRun = Date.parse(payload.next_run_at as string);
    expect(nextRun).toBeGreaterThanOrEqual(before + 90_000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 150_000 + 1000);
    // Retryable Gmail errors are surfaced to pubsub_events for operators.
    const events = fake.calls.inserts.filter((i) => i.table === "pubsub_events");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ event_type: "gmail_api_error" });
  });

  it("a retryable failure past the free window increments attempt", async () => {
    claim([job({ attempt: RETRYABLE_FREE_ATTEMPTS })]);
    processGmailMessage.mockRejectedValue(new GmailApiError("flaky 500", 500, true));
    await runMessageJobs(10, 2);
    expect(jobUpdates()[0].payload).toMatchObject({
      status: "pending",
      attempt: RETRYABLE_FREE_ATTEMPTS + 1,
    });
  });

  it("classifies plain network errors as retryable via the message regex", async () => {
    claim([job({ attempt: 0 })]);
    processGmailMessage.mockRejectedValue(new Error("connect ETIMEDOUT 1.2.3.4"));
    const summary = await runMessageJobs(10, 2);
    expect(summary).toMatchObject({ retryable: 1 });
    // Free retry: attempt stays 0.
    expect(jobUpdates()[0].payload).toMatchObject({ status: "pending", attempt: 0 });
    // No Gmail status → no pubsub_events alert.
    expect(fake.calls.inserts.filter((i) => i.table === "pubsub_events")).toHaveLength(0);
  });

  it("a non-retryable error at the last attempt lands in DLQ", async () => {
    claim([job({ attempt: MAX_JOB_ATTEMPTS - 1 })]);
    processGmailMessage.mockRejectedValue(new Error("parse exploded"));
    const summary = await runMessageJobs(10, 2);
    expect(summary).toMatchObject({ dlq: 1, ok: 0 });
    expect(jobUpdates()[0].payload).toMatchObject({
      status: "dlq",
      attempt: MAX_JOB_ATTEMPTS,
      last_error: "parse exploded",
    });
  });
});

describe("AI lane routing", () => {
  it("deferAiToCron requeues the job for the live cron instead of classifying inline", async () => {
    claim([job()]);
    processGmailMessage.mockResolvedValue(needsAiResult("e-1"));
    const before = Date.now();
    const summary = await runMessageJobs(10, 2, { deferAiToCron: true });
    expect(summary).toMatchObject({ processed: 1, ok: 1 });
    // The row is inserted and visible; the AI step is handed to the cron.
    expect(classifyEmail).not.toHaveBeenCalled();
    expect(classifyEmailsBatch).not.toHaveBeenCalled();
    expect(jobDeletes()).toHaveLength(0);
    const payload = jobUpdates()[0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({ status: "pending", locked_at: null });
    const nextRun = Date.parse(payload.next_run_at as string);
    expect(nextRun).toBeGreaterThanOrEqual(before + WEBHOOK_DEFERRED_AI_REQUEUE_MS - 50);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + WEBHOOK_DEFERRED_AI_REQUEUE_MS + 1000);
    // processGmailMessage ran with skipAi so no inline AI call happened.
    expect(processGmailMessage.mock.calls[0][3]).toMatchObject({ skipAi: true });
  });

  it("a live claim below LIVE_BATCH_AI_THRESHOLD keeps the inline AI path", async () => {
    claim([job()]);
    processGmailMessage.mockResolvedValue({ skipped: true });
    const summary = await runMessageJobs(10, 2);
    expect(summary).toMatchObject({ processed: 1, ok: 1 });
    expect(processGmailMessage.mock.calls[0][3]).toMatchObject({ skipAi: false });
    expect(classifyEmailsBatch).not.toHaveBeenCalled();
    expect(jobDeletes()).toHaveLength(1);
  });

  it(`a live burst of ${LIVE_BATCH_AI_THRESHOLD} routes AI through the batched classifier in chunks of 8`, async () => {
    const jobs = Array.from({ length: LIVE_BATCH_AI_THRESHOLD }, (_, i) =>
      job({ id: `job-${i}`, gmail_message_id: `gm-${i}` }),
    );
    claim(jobs);
    fake.seed(
      "emails",
      jobs.map((j) => ({ id: `email-${j.id}`, classified_by: "pending_ai", folder_id: null })),
    );
    processGmailMessage.mockImplementation(async (_acc, gmailId: string) => {
      const idx = gmailId.split("-")[1];
      return needsAiResult(`email-job-${idx}`);
    });
    classifyEmailsBatch.mockImplementation(async (items: unknown[]) =>
      items.map(() => ({ folder_id: "folder-A", confidence: 0.95, summary: "s", reason: "r" })),
    );

    const summary = await runMessageJobs(100, 4);
    expect(summary).toMatchObject({
      processed: LIVE_BATCH_AI_THRESHOLD,
      ok: LIVE_BATCH_AI_THRESHOLD,
    });
    // Every job deferred its inline AI…
    for (const call of processGmailMessage.mock.calls) {
      expect(call[3]).toMatchObject({ skipAi: true });
    }
    // …and the batch classifier ran in chunks of 8.
    expect(classifyEmailsBatch.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([
      8,
      LIVE_BATCH_AI_THRESHOLD - 8,
    ]);
    expect(jobDeletes()).toHaveLength(LIVE_BATCH_AI_THRESHOLD);
    expect(applyFolderActions).toHaveBeenCalledTimes(LIVE_BATCH_AI_THRESHOLD);
  });

  it("the batch pass honors min_ai_confidence — low confidence files nothing", async () => {
    ctxFolders = [folderA({ min_ai_confidence: 0.9 })];
    claim([job({ priority: 10 })]); // backfill lane always defers AI
    fake.seed("emails", [{ id: "email-1", classified_by: "pending_ai", folder_id: null }]);
    processGmailMessage.mockResolvedValue(needsAiResult("email-1"));
    classifyEmailsBatch.mockResolvedValue([
      { folder_id: "folder-A", confidence: 0.5, summary: "s", reason: "r" },
    ]);

    const summary = await runMessageJobs(10, 2);
    expect(summary).toMatchObject({ processed: 1, ok: 1 });
    // Below the folder's own bar: no folder actions, no learn bump.
    expect(applyFolderActions).not.toHaveBeenCalled();
    expect(bumpEmailsSinceLearn).not.toHaveBeenCalled();
    expect(updateEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({
        email_id: "email-1",
        folder_id: null,
        classified_by: "ai_low_confidence",
        ai_confidence: 0.5,
        classification_reason: 'AI suggested "A" at 50% < min 90%',
      }),
    );
    expect(jobDeletes()).toHaveLength(1);
  });
});
