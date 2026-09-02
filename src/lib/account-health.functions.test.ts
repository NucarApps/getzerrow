// src/lib/account-health.functions.ts — the Settings health card and its DLQ
// drawer. Everything runs on the service-role client, so every query and every
// write has to carry `user_id = caller` by hand; that is what these tests hold
// it to, alongside the diagnostic's failure ladder.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";

const fake = makeSupabaseFake({ applyWrites: true });

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const getAccessToken = vi.hoisted(() => vi.fn<(accountId: string) => Promise<string>>());
vi.mock("@/lib/google-oauth.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google-oauth.server")>(
    "@/lib/google-oauth.server",
  );
  return {
    getAccessToken: (accountId: string) => getAccessToken(accountId),
    NeedsReconnectError: actual.NeedsReconnectError,
  };
});

const ensureWatch = vi.hoisted(() =>
  vi.fn<(...a: unknown[]) => Promise<{ historyId: string; expiration: string } | null>>(),
);
vi.mock("@/lib/gmail.server", () => ({
  ensureWatch: (...a: unknown[]) => ensureWatch(...a),
}));

import { NeedsReconnectError } from "@/lib/google-oauth.server";
import {
  getAccountHealth,
  listDlqJobs,
  retryDlqJobs,
  retryDlqJob,
  deleteDlqJob,
  runAccountDiagnostic,
} from "./account-health.functions";

const USER = TEST_USER;
const ATTACKER = "attacker-user-9";
const VICTIM = "victim-user-7";
const ACCOUNT = "aaaaaaaa-1111-4111-8111-111111111111";
const JOB = "bbbbbbbb-2222-4222-8222-222222222222";
const NOW = "2026-05-10T12:00:00.000Z";

/** Call a stubbed server fn with a request context. The real `createServerFn`
 *  signature has no `context` slot — only the stub honors one, the same trick
 *  `impersonate` uses. */
function asUser<R>(fn: (...args: never[]) => Promise<R>, userId: string): () => Promise<R> {
  const stubbed = fn as unknown as (a: { context: Record<string, unknown> }) => Promise<R>;
  return () => stubbed({ context: { userId } });
}

beforeEach(() => {
  fake.reset();
  getAccessToken.mockReset();
  ensureWatch.mockReset();
  getAccessToken.mockResolvedValue("token");
  ensureWatch.mockResolvedValue(null);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* getAccountHealth                                                            */
/* -------------------------------------------------------------------------- */

describe("getAccountHealth", () => {
  it("returns nothing for a user with no mailboxes and never touches the queue", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: VICTIM, email_address: "v@acme.test" }]);

    const res = await asUser(getAccountHealth, ATTACKER)();

    expect(res).toStrictEqual({ accounts: [] });
    expect(fake.calls.selects.map((s) => s.table)).toStrictEqual(["gmail_accounts"]);
  });

  it("counts only the caller's queue rows per account and surfaces the latest push and error", async () => {
    fake.seed("gmail_accounts", [
      {
        id: ACCOUNT,
        user_id: USER,
        email_address: "me@acme.test",
        last_poll_at: "2026-05-10T11:00:00Z",
        watch_expiration: "2026-05-17T00:00:00Z",
        needs_reconnect: null,
        last_oauth_error: null,
      },
    ]);
    fake.seed("message_jobs", [
      { id: "j1", user_id: USER, gmail_account_id: ACCOUNT, status: "pending", updated_at: NOW },
      { id: "j2", user_id: USER, gmail_account_id: ACCOUNT, status: "pending", updated_at: NOW },
      { id: "j3", user_id: USER, gmail_account_id: ACCOUNT, status: "running", updated_at: NOW },
      {
        id: "j4",
        user_id: USER,
        gmail_account_id: ACCOUNT,
        status: "dlq",
        last_error: "recent boom",
        updated_at: "2026-05-10T11:59:00Z",
      },
      // Older than the one-hour error window.
      {
        id: "j5",
        user_id: USER,
        gmail_account_id: ACCOUNT,
        status: "dlq",
        last_error: "stale boom",
        updated_at: "2026-05-10T09:00:00Z",
      },
      // Another tenant's rows must not be counted.
      { id: "j6", user_id: VICTIM, gmail_account_id: ACCOUNT, status: "pending", updated_at: NOW },
    ]);
    fake.seed("pubsub_events", [
      {
        id: "p1",
        email_address: "me@acme.test",
        event_type: "push",
        received_at: "2026-05-10T10:00:00Z",
      },
      {
        id: "p2",
        email_address: "me@acme.test",
        event_type: "push",
        received_at: "2026-05-10T11:30:00Z",
      },
    ]);

    const res = await asUser(getAccountHealth, USER)();

    expect(res.accounts).toStrictEqual([
      {
        accountId: ACCOUNT,
        email: "me@acme.test",
        lastPollAt: "2026-05-10T11:00:00Z",
        lastPushAt: "2026-05-10T11:30:00Z",
        watchExpiresAt: "2026-05-17T00:00:00Z",
        pending: 2,
        running: 1,
        dlq: 2,
        lastError: "recent boom",
        needsReconnect: false,
        lastOauthError: null,
      },
    ]);
    expect(writeCount(fake)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* listDlqJobs                                                                 */
/* -------------------------------------------------------------------------- */

describe("listDlqJobs", () => {
  it("returns only the caller's dead-lettered rows for that account", async () => {
    fake.seed("message_jobs", [
      {
        id: JOB,
        user_id: USER,
        gmail_account_id: ACCOUNT,
        status: "dlq",
        gmail_message_id: "m1",
        from_addr: "sender@acme.test",
        subject: "Boom",
        attempt: 5,
        last_error: "failed",
        updated_at: NOW,
      },
      // Same account, another tenant.
      {
        id: "j-foreign",
        user_id: VICTIM,
        gmail_account_id: ACCOUNT,
        status: "dlq",
        gmail_message_id: "m2",
        attempt: 1,
        updated_at: NOW,
      },
      // Caller's row, but still queued.
      {
        id: "j-pending",
        user_id: USER,
        gmail_account_id: ACCOUNT,
        status: "pending",
        gmail_message_id: "m3",
        attempt: 0,
        updated_at: NOW,
      },
    ]);

    const res = await listDlqJobs({ data: { account_id: ACCOUNT } });

    expect(res.rows).toStrictEqual([
      {
        id: JOB,
        gmailMessageId: "m1",
        fromAddr: "sender@acme.test",
        subject: "Boom",
        attempt: 5,
        lastError: "failed",
        updatedAt: NOW,
      },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* retryDlqJobs / retryDlqJob / deleteDlqJob                                   */
/* -------------------------------------------------------------------------- */

const REQUEUE_PATCH = {
  status: "pending",
  attempt: 0,
  next_run_at: NOW,
  locked_at: null,
  last_error: null,
};

describe("retryDlqJobs", () => {
  it("re-queues every dead-lettered row for that account and only for the caller", async () => {
    fake.seed("message_jobs", [
      {
        id: JOB,
        user_id: USER,
        gmail_account_id: ACCOUNT,
        status: "dlq",
        attempt: 5,
        locked_at: NOW,
        last_error: "boom",
        next_run_at: NOW,
      },
      {
        id: "j-foreign",
        user_id: VICTIM,
        gmail_account_id: ACCOUNT,
        status: "dlq",
        attempt: 5,
        locked_at: NOW,
        last_error: "boom",
        next_run_at: NOW,
      },
    ]);

    const res = await retryDlqJobs({ data: { account_id: ACCOUNT } });

    expect(res).toStrictEqual({ requeued: 1 });
    const update = fake.calls.updates.find((u) => u.table === "message_jobs")!;
    expect(update.payload).toStrictEqual(REQUEUE_PATCH);
    // The `{ count: "exact" }` option the source passes is not forwarded by the
    // shared fake's `update()`; the returned count is asserted above instead.
    expect(update.filters).toStrictEqual([
      { op: "eq", col: "user_id", value: USER, extra: undefined },
      { op: "eq", col: "gmail_account_id", value: ACCOUNT, extra: undefined },
      { op: "eq", col: "status", value: "dlq", extra: undefined },
    ]);
    expect(fake.rows("message_jobs").find((j) => j.id === "j-foreign")).toMatchObject({
      status: "dlq",
      attempt: 5,
    });
  });

  it("propagates an update failure", async () => {
    fake.onUpdate("message_jobs", () => ({ message: "requeue blocked" }));
    await expect(retryDlqJobs({ data: { account_id: ACCOUNT } })).rejects.toThrow(
      "requeue blocked",
    );
  });
});

describe("retryDlqJob", () => {
  it("re-queues one row, scoped by id, caller and dlq status", async () => {
    fake.seed("message_jobs", [
      {
        id: JOB,
        user_id: USER,
        gmail_account_id: ACCOUNT,
        status: "dlq",
        attempt: 5,
        locked_at: NOW,
        last_error: "boom",
        next_run_at: NOW,
      },
    ]);

    await expect(retryDlqJob({ data: { job_id: JOB } })).resolves.toStrictEqual({ ok: true });

    const update = fake.calls.updates.find((u) => u.table === "message_jobs")!;
    expect(update.payload).toStrictEqual(REQUEUE_PATCH);
    expect(update.filters).toStrictEqual([
      { op: "eq", col: "id", value: JOB, extra: undefined },
      { op: "eq", col: "user_id", value: USER, extra: undefined },
      { op: "eq", col: "status", value: "dlq", extra: undefined },
    ]);
    expect(fake.rows("message_jobs")[0]).toMatchObject({ status: "pending", attempt: 0 });
  });

  it("cannot re-queue another user's job", async () => {
    fake.seed("message_jobs", [
      {
        id: JOB,
        user_id: VICTIM,
        gmail_account_id: ACCOUNT,
        status: "dlq",
        attempt: 5,
        next_run_at: NOW,
      },
    ]);

    await impersonate(retryDlqJob, ATTACKER)({ data: { job_id: JOB } });

    expect(fake.rows("message_jobs")[0]).toMatchObject({ status: "dlq", attempt: 5 });
  });
});

describe("deleteDlqJob", () => {
  it("deletes one row, scoped by id, caller and dlq status", async () => {
    fake.seed("message_jobs", [
      { id: JOB, user_id: USER, gmail_account_id: ACCOUNT, status: "dlq", next_run_at: NOW },
    ]);

    await expect(deleteDlqJob({ data: { job_id: JOB } })).resolves.toStrictEqual({ ok: true });

    expect(fake.calls.deletes[0]!.filters).toStrictEqual([
      { op: "eq", col: "id", value: JOB, extra: undefined },
      { op: "eq", col: "user_id", value: USER, extra: undefined },
      { op: "eq", col: "status", value: "dlq", extra: undefined },
    ]);
    expect(fake.rows("message_jobs")).toStrictEqual([]);
  });

  it("cannot delete another user's job", async () => {
    fake.seed("message_jobs", [
      { id: JOB, user_id: VICTIM, gmail_account_id: ACCOUNT, status: "dlq", next_run_at: NOW },
    ]);

    await impersonate(deleteDlqJob, ATTACKER)({ data: { job_id: JOB } });

    expect(fake.rows("message_jobs")).toHaveLength(1);
  });

  it("propagates a delete failure", async () => {
    fake.onDelete("message_jobs", () => ({ message: "delete blocked" }));
    await expect(deleteDlqJob({ data: { job_id: JOB } })).rejects.toThrow("delete blocked");
  });
});

/* -------------------------------------------------------------------------- */
/* runAccountDiagnostic                                                        */
/* -------------------------------------------------------------------------- */

describe("runAccountDiagnostic", () => {
  it("reports 'Account not found' for another user's mailbox without calling Google", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: VICTIM, email_address: "v@acme.test" }]);

    const res = await impersonate(
      runAccountDiagnostic,
      ATTACKER,
    )({ data: { account_id: ACCOUNT } });

    expect(res).toStrictEqual({
      accessToken: "error",
      watch: "skipped",
      watchExpiresAt: null,
      historyId: null,
      error: "Account not found",
    });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(ensureWatch).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("stops at needs_reconnect without attempting the watch", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: USER, email_address: "me@acme.test" }]);
    getAccessToken.mockRejectedValue(new NeedsReconnectError(ACCOUNT, "invalid_grant"));

    const res = await runAccountDiagnostic({ data: { account_id: ACCOUNT } });

    expect(res).toStrictEqual({
      accessToken: "needs_reconnect",
      watch: "skipped",
      watchExpiresAt: null,
      historyId: null,
      error: `Account ${ACCOUNT} needs reconnect: invalid_grant`,
    });
    expect(ensureWatch).not.toHaveBeenCalled();
  });

  it("reports a generic token failure as an error and skips the watch", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: USER, email_address: "me@acme.test" }]);
    getAccessToken.mockRejectedValue(new Error("network down"));

    const res = await runAccountDiagnostic({ data: { account_id: ACCOUNT } });

    expect(res).toStrictEqual({
      accessToken: "error",
      watch: "skipped",
      watchExpiresAt: null,
      historyId: null,
      error: "network down",
    });
    expect(ensureWatch).not.toHaveBeenCalled();
  });

  it("persists the history id and watch expiry when the top-up succeeds", async () => {
    fake.seed("gmail_accounts", [
      {
        id: ACCOUNT,
        user_id: USER,
        email_address: "me@acme.test",
        history_id: null,
        watch_expiration: null,
      },
    ]);
    ensureWatch.mockResolvedValue({ historyId: "512", expiration: "1780000000000" });
    const expectedExpiry = new Date(1780000000000).toISOString();

    const res = await runAccountDiagnostic({ data: { account_id: ACCOUNT } });

    expect(res).toStrictEqual({
      accessToken: "ok",
      watch: "ok",
      watchExpiresAt: expectedExpiry,
      historyId: "512",
      error: null,
    });
    const update = fake.calls.updates.find((u) => u.table === "gmail_accounts")!;
    expect(update.payload).toStrictEqual({
      history_id: "512",
      watch_expiration: expectedExpiry,
    });
  });

  it("records a skipped watch without writing anything when Gmail declines", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: USER, email_address: "me@acme.test" }]);
    ensureWatch.mockResolvedValue(null);

    const res = await runAccountDiagnostic({ data: { account_id: ACCOUNT } });

    expect(res).toStrictEqual({
      accessToken: "ok",
      watch: "skipped",
      watchExpiresAt: null,
      historyId: null,
      error: null,
    });
    expect(writeCount(fake)).toBe(0);
  });

  it("reports a watch failure while keeping the token verdict", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: USER, email_address: "me@acme.test" }]);
    ensureWatch.mockRejectedValue(new Error("topic missing"));

    const res = await runAccountDiagnostic({ data: { account_id: ACCOUNT } });

    expect(res).toStrictEqual({
      accessToken: "ok",
      watch: "error",
      watchExpiresAt: null,
      historyId: null,
      error: "topic missing",
    });
  });
});
