// Unit tests for the Gmail sync/action server functions
// (src/lib/gmail/sync.functions.ts). Contracts pinned:
//
//   - getBackfillStatus prefers an active job and FALLS BACK to the most
//     recent finished one (regression: a reused PostgREST builder kept the
//     active-status filter on the fallback, so a finished job was never
//     reported);
//   - trashEmail never deletes the local row when Gmail's trash call fails
//     (otherwise reconcile re-ingests it and the email ghosts back);
//   - archiveEmail rethrows a Gmail failure and writes nothing, while
//     markEmailRead swallows the Gmail failure and still writes — the
//     asymmetry is deliberate (read-state is reconciled by cron) and pinned;
//   - archive strips INBOX from raw_labels in the same UPDATE so realtime
//     subscribers drop the row;
//   - sendReply does not double-prefix "Re:";
//   - renewGmailWatch forces renewal (null historyId) and logs to
//     pubsub_events best-effort;
//   - every id-taking fn denies a caller who does not own the email/account
//     before any Gmail call or write.
//
// Harness: __fixtures__/server-fn-stub + __fixtures__/supabase-fake;
// gmail-helpers.server (getOwnedAccount / getEmailAccount) stays REAL so the
// ownership checks are the production ones.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";

const fake = makeSupabaseFake();

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

const { modifyMessage, trashMessage, sendMessage, ensureWatch } = vi.hoisted(() => ({
  modifyMessage: vi.fn(async (..._a: unknown[]) => ({})),
  trashMessage: vi.fn(async (..._a: unknown[]) => ({})),
  sendMessage: vi.fn(async (..._a: unknown[]) => ({ id: "sent-1" })),
  ensureWatch: vi.fn(
    async (..._a: unknown[]): Promise<{ historyId: string; expiration: string } | null> => null,
  ),
}));
vi.mock("../gmail.server", () => ({ modifyMessage, trashMessage, sendMessage, ensureWatch }));

vi.mock("../sync.server", () => ({
  backfillRecent: vi.fn(),
  backfillWindow: vi.fn(),
  syncSinceHistory: vi.fn(),
  reconcileLocalInbox: vi.fn(),
  startBackfillJob: vi.fn(),
  cancelBackfillJob: vi.fn(),
  syncReadState: vi.fn(),
}));
vi.mock("../gmail-helpers.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("../gmail-helpers.server")>();
  return { ...real, drainCatchupRounds: vi.fn() };
});
vi.mock("../ai.server", () => ({ suggestReply: vi.fn(async () => "draft") }));
const logError = vi.fn();
vi.mock("../log.server", () => ({
  logError: (...a: unknown[]) => logError(...a),
  logInfo: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("../sync/encrypted-writer", () => ({
  setReplyDraftEncrypted: vi.fn(async () => ({ error: null })),
}));
const getEmailsDecrypted = vi.fn(async (_ids: string[]) => ({
  rows: [{ id: EMAIL, subject: "Hello", body_text: "body", from_name: "Ann" }],
  error: null,
}));
vi.mock("../sync/encrypted-reader", () => ({
  getEmailsDecrypted: (ids: string[]) => getEmailsDecrypted(ids),
}));

import {
  getBackfillStatus,
  archiveEmail,
  trashEmail,
  markEmailRead,
  sendReply,
  renewGmailWatch,
} from "./sync.functions";

const ACC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMAIL = "11111111-1111-4111-8111-111111111111";

function seedEmail(over: Record<string, unknown> = {}) {
  fake.seed("emails", [
    {
      id: EMAIL,
      user_id: TEST_USER,
      gmail_account_id: ACC,
      gmail_message_id: "gm-1",
      thread_id: "t-1",
      from_addr: "ann@example.com",
      raw_labels: ["INBOX", "UNREAD"],
      ...over,
    },
  ]);
}

beforeEach(() => {
  fake.reset();
});

/* -------------------------------------------------------------------------- */

describe("getBackfillStatus", () => {
  const job = (over: Record<string, unknown>) => ({
    user_id: TEST_USER,
    gmail_account_id: ACC,
    months: 6,
    total_found: 10,
    total_enqueued: 10,
    already_had: 0,
    finished_at: null,
    last_error: null,
    ...over,
  });

  it("prefers the most recent ACTIVE job over a newer finished one", async () => {
    fake.seed("backfill_jobs", [
      job({ id: "j-done", status: "done", started_at: "2026-09-01T10:00:00Z" }),
      job({ id: "j-active", status: "processing", started_at: "2026-09-01T09:00:00Z" }),
    ]);
    fake.seed("message_jobs", [
      { id: "m1", gmail_account_id: ACC, status: "pending" },
      { id: "m2", gmail_account_id: ACC, status: "dlq" },
    ]);
    const res = await getBackfillStatus({ data: {} });
    expect(res.job).toMatchObject({ id: "j-active", status: "processing", remaining: 1 });
  });

  it("falls back to the most recent FINISHED job when nothing is active (regression: reused builder)", async () => {
    fake.seed("backfill_jobs", [
      job({ id: "j-old", status: "done", started_at: "2026-08-01T10:00:00Z" }),
      job({ id: "j-new", status: "failed", started_at: "2026-09-01T10:00:00Z" }),
    ]);
    const res = await getBackfillStatus({ data: {} });
    expect(res.job).toMatchObject({ id: "j-new", status: "failed", remaining: 0 });
  });

  it("scopes to the requested account and to the caller", async () => {
    const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    fake.seed("backfill_jobs", [
      job({ id: "j-other-acc", status: "done", gmail_account_id: OTHER, started_at: "2026-09-02" }),
      job({ id: "j-other-user", status: "done", user_id: "someone", started_at: "2026-09-03" }),
      job({ id: "j-mine", status: "done", started_at: "2026-09-01" }),
    ]);
    const res = await getBackfillStatus({ data: { account_id: ACC } });
    expect(res.job).toMatchObject({ id: "j-mine" });
  });

  it("returns { job: null } when the user has no jobs", async () => {
    await expect(getBackfillStatus({ data: {} })).resolves.toEqual({ job: null });
  });
});

/* -------------------------------------------------------------------------- */

describe("trashEmail", () => {
  it("trashes in Gmail, then deletes the local row", async () => {
    seedEmail();
    await expect(trashEmail({ data: { id: EMAIL } })).resolves.toEqual({ ok: true });
    expect(trashMessage).toHaveBeenCalledWith(ACC, "gm-1");
    expect(fake.calls.deletes).toEqual([
      {
        table: "emails",
        payload: null,
        options: undefined,
        filters: [{ op: "eq", col: "id", value: EMAIL }],
      },
    ]);
  });

  it("does NOT delete the local row when Gmail's trash call fails", async () => {
    seedEmail();
    trashMessage.mockRejectedValueOnce(new Error("gmail 503"));
    await expect(trashEmail({ data: { id: EMAIL } })).rejects.toThrow(
      "Couldn't move the email to Gmail's trash",
    );
    expect(fake.calls.deletes).toHaveLength(0);
    expect(logError).toHaveBeenCalledWith(
      "gmail.archive.modify_failed",
      { email_id: EMAIL, account_id: ACC, gmail_message_id: "gm-1" },
      expect.any(Error),
    );
  });

  it("denies a caller who does not own the email before touching Gmail", async () => {
    seedEmail();
    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(trashEmail, "intruder")({ data: { id: EMAIL } }),
      rejects: "Not authorized",
    });
    expect(trashMessage).not.toHaveBeenCalled();
  });
});

describe("archiveEmail", () => {
  it("removes INBOX in Gmail, then marks archived and strips INBOX from raw_labels in one UPDATE", async () => {
    seedEmail();
    await expect(archiveEmail({ data: { id: EMAIL } })).resolves.toEqual({ ok: true });
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-1", [], ["INBOX"]);
    expect(fake.calls.updates).toEqual([
      {
        table: "emails",
        payload: { is_archived: true, raw_labels: ["UNREAD"] },
        options: undefined,
        filters: [{ op: "eq", col: "id", value: EMAIL }],
      },
    ]);
  });

  it("rethrows a Gmail failure and writes nothing", async () => {
    seedEmail();
    modifyMessage.mockRejectedValueOnce(new Error("gmail down"));
    await expect(archiveEmail({ data: { id: EMAIL } })).rejects.toThrow("gmail down");
    expect(fake.calls.updates).toHaveLength(0);
  });

  it("denies a caller who does not own the email", async () => {
    seedEmail();
    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(archiveEmail, "intruder")({ data: { id: EMAIL } }),
    });
    expect(modifyMessage).not.toHaveBeenCalled();
  });
});

describe("markEmailRead", () => {
  it("clears UNREAD in Gmail and writes is_read", async () => {
    seedEmail();
    await markEmailRead({ data: { id: EMAIL, read: true } });
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-1", [], ["UNREAD"]);
    expect(fake.calls.updates[0]).toMatchObject({ table: "emails", payload: { is_read: true } });
  });

  it("marking unread adds the UNREAD label", async () => {
    seedEmail();
    await markEmailRead({ data: { id: EMAIL, read: false } });
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-1", ["UNREAD"], []);
  });

  it("a Gmail failure is logged and the local write still happens (read-state is cron-reconciled)", async () => {
    seedEmail();
    modifyMessage.mockRejectedValueOnce(new Error("gmail down"));
    await expect(markEmailRead({ data: { id: EMAIL, read: true } })).resolves.toEqual({ ok: true });
    expect(logError).toHaveBeenCalledWith("gmail.unknown_op_failed", {}, expect.any(Error));
    expect(fake.calls.updates).toHaveLength(1);
  });

  it("denies a caller who does not own the email", async () => {
    seedEmail();
    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(markEmailRead, "intruder")({ data: { id: EMAIL, read: true } }),
    });
  });
});

describe("sendReply", () => {
  it("prefixes Re: once and threads onto the original message", async () => {
    seedEmail();
    await sendReply({ data: { id: EMAIL, body: "Thanks!" } });
    expect(sendMessage).toHaveBeenCalledWith(
      ACC,
      "ann@example.com",
      "Re: Hello",
      "Thanks!",
      "t-1",
      "gm-1",
    );
  });

  it("does not double-prefix a subject that already starts with Re:", async () => {
    seedEmail();
    getEmailsDecrypted.mockResolvedValueOnce({
      rows: [{ id: EMAIL, subject: "Re: Hello", body_text: "", from_name: "" }],
      error: null,
    });
    await sendReply({ data: { id: EMAIL, body: "Thanks!" } });
    expect(sendMessage.mock.calls[0]?.[2]).toBe("Re: Hello");
  });

  it("denies a caller who does not own the email before sending", async () => {
    seedEmail();
    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(sendReply, "intruder")({ data: { id: EMAIL, body: "x" } }),
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("renewGmailWatch", () => {
  beforeEach(() => {
    fake.seed("gmail_accounts", [{ id: ACC, user_id: TEST_USER, email_address: "me@x.com" }]);
  });

  it("forces renewal, stores the new cursor/expiration, and logs a pubsub event", async () => {
    ensureWatch.mockResolvedValueOnce({ historyId: "h-9", expiration: "1760000000000" });
    vi.stubEnv("GMAIL_PUBSUB_TOPIC", "projects/x/topics/t");
    const res = await renewGmailWatch({ data: { account_id: ACC } });
    expect(ensureWatch).toHaveBeenCalledWith(ACC, null);
    expect(res).toEqual({ expiration: "1760000000000", topic: "projects/x/topics/t" });
    expect(fake.calls.updates[0]).toMatchObject({
      table: "gmail_accounts",
      payload: { history_id: "h-9", watch_expiration: new Date(1760000000000).toISOString() },
      filters: [{ op: "eq", col: "id", value: ACC }],
    });
    expect(fake.calls.inserts[0]).toMatchObject({
      table: "pubsub_events",
      payload: { event_type: "watch_renew", email_address: "me@x.com", history_id: "h-9" },
    });
  });

  it("throws when the topic is not configured (ensureWatch returns null) and writes nothing", async () => {
    ensureWatch.mockResolvedValueOnce(null);
    await expect(renewGmailWatch({ data: { account_id: ACC } })).rejects.toThrow(
      "GMAIL_PUBSUB_TOPIC is not configured",
    );
    expect(fake.calls.updates).toHaveLength(0);
  });

  it("a failed pubsub_events insert is logged, not surfaced", async () => {
    ensureWatch.mockResolvedValueOnce({ historyId: "h-9", expiration: "1760000000000" });
    fake.onInsert("pubsub_events", () => {
      throw new Error("insert failed");
    });
    await expect(renewGmailWatch({ data: { account_id: ACC } })).resolves.toMatchObject({
      expiration: "1760000000000",
    });
    expect(logError).toHaveBeenCalledWith(
      "gmail.watch_renew.log_failed",
      { account_id: ACC },
      expect.any(Error),
    );
  });

  it("denies a caller who does not own the account", async () => {
    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(renewGmailWatch, "intruder")({ data: { account_id: ACC } }),
      rejects: "Not authorized for this account",
    });
    expect(ensureWatch).not.toHaveBeenCalled();
  });
});
