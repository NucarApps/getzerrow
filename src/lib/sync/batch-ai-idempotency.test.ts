// End-to-end test for the batch-AI second pass idempotency gate in
// runMessageJobs.
//
// Simulates two failure modes that would otherwise cause double folder
// actions or duplicate learn-counter bumps:
//
//   1. Retry after partial success — a prior tick applied + persisted the
//      classification but crashed before deleting the job row. The stuck
//      reclaim re-claims the same job on the next tick. The emails row is
//      ALREADY at classified_by='ai' with folder_id set when the batch
//      pass runs.
//
//   2. In-batch duplicate delivery — two claimed jobs point at the same
//      email row (e.g. same message_id enqueued twice around the unique
//      index via a race). The first item flips the row to classified;
//      the second item's gate then rejects it.
//
// The gate lives in run-jobs.ts::isEmailPendingClassification. Both the
// batch-success path and the batch-fallback single-classify path must
// honor it.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─────────────── State captured by mocks ─────────────────────────────

type ClaimedJob = {
  id: string;
  gmail_account_id: string;
  gmail_message_id: string;
  user_id: string;
  attempt: number;
  priority: number;
  published_at_ms: number | null;
};

type EmailRow = {
  id: string;
  classified_by: string | null;
  folder_id: string | null;
};

const claimedQueue: ClaimedJob[] = [];
const emailsById = new Map<string, EmailRow>();
const jobRowById = new Map<string, ClaimedJob>();
const jobDeletes: string[] = [];
const applyCalls: Array<{ gmailMessageId: string; emailRowId: string; folderId: string }> = [];
const updateCalls: Array<{
  email_id: string;
  folder_id: string | null | undefined;
  classified_by: string | null | undefined;
}> = [];
const bumpCalls: string[] = [];
const batchCalls: number[] = []; // chunk sizes per batch AI call

// Force the batch-fallback branch by having classifyEmailsBatch throw.
let batchShouldThrow = false;

// Small helper to run all queued microtasks so fire-and-forget bumps land.
async function flushMicrotasks() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

// ─────────────── supabaseAdmin fake ──────────────────────────────────

function emailsSelectBuilder() {
  let idFilter: string | null = null;
  const chain = {
    select() {
      return chain;
    },
    eq(col: string, val: string) {
      if (col === "id") idFilter = val;
      return chain;
    },
    async maybeSingle() {
      if (!idFilter) return { data: null, error: null };
      const row = emailsById.get(idFilter) ?? null;
      return { data: row, error: null };
    },
    limit() {
      return Promise.resolve({ data: [], error: null });
    },
  };
  return chain;
}

function messageJobsBuilder() {
  const state: { op: string; filterId: string | null } = { op: "select", filterId: null };
  const chain: Record<string, unknown> = {
    select() {
      state.op = "select";
      return chain;
    },
    // The stuck-check queries: .select().eq('status','running').lt('locked_at', …)
    eq() {
      return chain;
    },
    lt() {
      // stuck query terminates with an await on the chain — resolve to []
      return Promise.resolve({ data: [], error: null });
    },
    delete() {
      state.op = "delete";
      return {
        eq(_col: string, id: string) {
          state.filterId = id;
          jobDeletes.push(id);
          return Promise.resolve({ error: null });
        },
      };
    },
    update() {
      return {
        eq() {
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return chain;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      if (table === "emails") return emailsSelectBuilder();
      if (table === "message_jobs") return messageJobsBuilder();
      // pubsub_events insert etc. — no-op.
      return {
        insert: () => Promise.resolve({ error: null }),
        select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
      };
    },
    async rpc(fn: string) {
      if (fn === "claim_message_jobs") {
        const rows = [...claimedQueue];
        claimedQueue.length = 0;
        return { data: rows, error: null };
      }
      return { data: null, error: null };
    },
  },
}));

// ─────────────── Other module fakes ──────────────────────────────────

vi.mock("../gmail.server", () => ({
  GmailApiError: class extends Error {
    status = 500;
    retryable = false;
    retryAfterSeconds: number | null = null;
    isQuotaExceeded = false;
  },
  async getMessageMetadata() {
    return {};
  },
  parseMessage: () => ({}),
}));

vi.mock("../ai.server", () => ({
  async classifyEmailsBatch(items: Array<unknown>) {
    batchCalls.push(items.length);
    if (batchShouldThrow) throw new Error("simulated batch failure");
    // Every message gets high-confidence assignment to folder-A.
    return items.map(() => ({
      folder_id: "folder-A",
      confidence: 0.95,
      summary: "s",
      reason: "r",
    }));
  },
  async classifyEmail() {
    return {
      folder_id: "folder-A",
      confidence: 0.95,
      summary: "s",
      reason: "r",
    };
  },
}));

vi.mock("./account-context", () => ({
  async loadAccountContext(accountId: string, userId: string) {
    return {
      accountId,
      userId,
      folders: [
        {
          id: "folder-A",
          name: "A",
          gmail_label_id: null,
          auto_archive: false,
          auto_mark_read: false,
          auto_star: false,
          hide_from_inbox: false,
          forward_to: null,
          snooze_hours: null,
          min_ai_confidence: 0,
        },
      ],
      enrichedFolders: [{ id: "folder-A", name: "A" }],
    };
  },
}));

vi.mock("./process-message", () => ({
  async processGmailMessage(
    accountId: string,
    gmailId: string,
    _userId: string,
    _opts: unknown,
  ) {
    const job = jobRowById.get(`${accountId}:${gmailId}`);
    if (!job) throw new Error(`no job registered for ${accountId}:${gmailId}`);
    // Test seeds the target emails row id in job.published_at_ms as a stable
    // integer we can re-use. Map via a side table for readability.
    const emailRowId = emailRowForJob.get(job.id)!;
    return {
      email_id: emailRowId,
      needs_ai: true,
      parsed: {
        raw_labels: ["INBOX"],
        subject: "hi",
        from_addr: "x@y.com",
        from_name: "X",
        received_at: new Date().toISOString(),
        body_text: "",
        snippet: "",
      },
    };
  },
  async applyFolderActions(
    _accountId: string,
    gmailMessageId: string,
    emailRowId: string,
    folder: { id: string },
  ) {
    applyCalls.push({ gmailMessageId, emailRowId, folderId: folder.id });
  },
}));

vi.mock("./encrypted-writer", () => ({
  async updateEmailEncrypted(patch: {
    email_id: string;
    folder_id?: string | null;
    classified_by?: string | null;
  }) {
    updateCalls.push({
      email_id: patch.email_id,
      folder_id: patch.folder_id,
      classified_by: patch.classified_by,
    });
    // Flip the emails row to reflect the persisted classification so the
    // gate for any later item in the same batch sees the terminal state.
    const existing = emailsById.get(patch.email_id);
    if (existing) {
      emailsById.set(patch.email_id, {
        ...existing,
        classified_by: patch.classified_by ?? existing.classified_by,
        folder_id: patch.folder_id ?? existing.folder_id,
      });
    }
  },
}));

vi.mock("./folder-learn", () => ({
  async bumpEmailsSinceLearn(folderId: string) {
    bumpCalls.push(folderId);
  },
  async recordManualMove() {},
}));

vi.mock("../log.server", () => ({
  logError: () => {},
  logInfo: () => {},
  newRunId: () => "test-run",
}));

// ─────────────── System under test ───────────────────────────────────

import { runMessageJobs } from "./run-jobs";

const emailRowForJob = new Map<string, string>();

function seedJob(opts: {
  jobId: string;
  gmailMessageId: string;
  emailRowId: string;
  emailState: EmailRow;
}) {
  const job: ClaimedJob = {
    id: opts.jobId,
    gmail_account_id: "acc-1",
    gmail_message_id: opts.gmailMessageId,
    user_id: "user-1",
    attempt: 0,
    priority: 10, // priority>=10 forces deferAi → batch second pass
    published_at_ms: null,
  };
  claimedQueue.push(job);
  jobRowById.set(`${job.gmail_account_id}:${job.gmail_message_id}`, job);
  emailRowForJob.set(opts.jobId, opts.emailRowId);
  emailsById.set(opts.emailRowId, opts.emailState);
}

beforeEach(() => {
  claimedQueue.length = 0;
  emailsById.clear();
  jobRowById.clear();
  jobDeletes.length = 0;
  applyCalls.length = 0;
  updateCalls.length = 0;
  bumpCalls.length = 0;
  batchCalls.length = 0;
  emailRowForJob.clear();
  batchShouldThrow = false;
});

describe("batch-AI second pass idempotency", () => {
  it("retry after partial success — pre-classified row is skipped, no duplicate apply/bump", async () => {
    // job-1 → email X (still pending, first-time processing)
    seedJob({
      jobId: "job-1",
      gmailMessageId: "msg-1",
      emailRowId: "email-X",
      emailState: { id: "email-X", classified_by: "pending_ai", folder_id: null },
    });
    // job-2 → email Y (RETRY: prior tick already applied + persisted before
    // it crashed; stuck-reclaim handed the same job back to this tick).
    seedJob({
      jobId: "job-2",
      gmailMessageId: "msg-2",
      emailRowId: "email-Y",
      emailState: { id: "email-Y", classified_by: "ai", folder_id: "folder-A" },
    });

    await runMessageJobs(10, 2);
    await flushMicrotasks();

    // Exactly one apply + one bump + one update for the fresh email; the
    // retry is short-circuited by the gate.
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]).toMatchObject({ emailRowId: "email-X", folderId: "folder-A" });
    expect(bumpCalls).toEqual(["folder-A"]);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].email_id).toBe("email-X");

    // Both job rows still get deleted — the queue must drain either way.
    expect(new Set(jobDeletes)).toEqual(new Set(["job-1", "job-2"]));

    // One batch AI call covering both messages.
    expect(batchCalls).toEqual([2]);
  });

  it("in-batch duplicate delivery — same email row in two jobs applies once", async () => {
    // Two jobs, same target email row. First one to persist flips the row
    // to classified; the second sees it and skips.
    seedJob({
      jobId: "job-1",
      gmailMessageId: "msg-1",
      emailRowId: "email-DUP",
      emailState: { id: "email-DUP", classified_by: "pending_ai", folder_id: null },
    });
    seedJob({
      jobId: "job-2",
      gmailMessageId: "msg-2",
      emailRowId: "email-DUP",
      emailState: { id: "email-DUP", classified_by: "pending_ai", folder_id: null },
    });

    await runMessageJobs(10, 2);
    await flushMicrotasks();

    // The gate + emails-row state-flip in updateEmailEncrypted collaborate
    // to serialize apply: exactly one folder action, one persist, one bump.
    expect(applyCalls).toHaveLength(1);
    expect(bumpCalls).toEqual(["folder-A"]);
    expect(updateCalls).toHaveLength(1);
    expect(new Set(jobDeletes)).toEqual(new Set(["job-1", "job-2"]));
  });

  it("batch-fallback single path also honors the idempotency gate", async () => {
    // Force the batch to fail so the code falls through to per-message
    // classifyEmail. The retry gate must still fire there.
    batchShouldThrow = true;

    seedJob({
      jobId: "job-1",
      gmailMessageId: "msg-1",
      emailRowId: "email-X",
      emailState: { id: "email-X", classified_by: "pending_ai", folder_id: null },
    });
    seedJob({
      jobId: "job-2",
      gmailMessageId: "msg-2",
      emailRowId: "email-Y",
      emailState: { id: "email-Y", classified_by: "ai", folder_id: "folder-A" },
    });

    await runMessageJobs(10, 2);
    await flushMicrotasks();

    // job-1 (fresh) goes through the fallback single classifier + apply;
    // job-2 (retry) is gated out before either step runs.
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0].emailRowId).toBe("email-X");
    expect(bumpCalls).toEqual(["folder-A"]);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].email_id).toBe("email-X");
    expect(new Set(jobDeletes)).toEqual(new Set(["job-1", "job-2"]));
  });
});
