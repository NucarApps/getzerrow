// Unit tests for syncSinceHistory's event handling and error taxonomy —
// the hot path behind every Pub/Sub push and poll tick. The concurrency
// contract (withAccountLock coalescing) is covered by
// history-concurrency.test.ts; these tests drive the same exported entry
// point through the supabase-fake and assert the per-event behavior:
//
//   * only a Gmail 404 (history genuinely expired) nulls history_id and
//     triggers a rebootstrap — 429/5xx must NOT clear the cursor,
//   * deletes are batched into one statement; TRASH/SPAM label adds drop
//     the local row; a TRASH removal re-ingests via the queue,
//   * label ↔ folder mirroring patches folder_id (clearing only when the
//     current folder matches the removed label),
//   * label ops for messages in seenAdded are skipped (row not inserted yet),
//   * recordManualMove fires only for existing local rows and the path
//     never calls getMessageMetadata (quota-spiral guard),
//   * the 25-page pagination cap, bootstrap anchoring/dedupe, the
//     bump_history_id_if_greater JS fallback, and last_push_at stamping.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

// Property accesses are deferred into method bodies so the hoisted factory
// never touches `fake` before its initializer runs.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

// ─── Gmail fake: scripted listHistory / listMessages queues ─────────────

type HistoryPage = {
  historyId?: string;
  history?: Array<Record<string, unknown>>;
  nextPageToken?: string;
};
const listHistoryCalls: Array<{ accountId: string; startHistoryId: string }> = [];
const listHistoryQueue: Array<HistoryPage | Error> = [];
const listMessagesCalls: Array<Record<string, unknown>> = [];
const listMessagesQueue: Array<{ messages?: Array<{ id: string }>; nextPageToken?: string }> = [];
const getMessageMetadataCalls: string[] = [];
let messageMetadata: { historyId?: string } = {};

vi.mock("../gmail.server", () => {
  class GmailApiError extends Error {
    status: number;
    retryable: boolean;
    retryAfterSeconds: number | null;
    isQuotaExceeded: boolean;
    constructor(message: string, status: number, retryable: boolean) {
      super(message);
      this.name = "GmailApiError";
      this.status = status;
      this.retryable = retryable;
      this.retryAfterSeconds = null;
      this.isQuotaExceeded = false;
    }
  }
  return {
    GmailApiError,
    async listHistory(accountId: string, startHistoryId: string) {
      listHistoryCalls.push({ accountId, startHistoryId });
      const next = listHistoryQueue.shift();
      if (next instanceof Error) throw next;
      return next ?? { historyId: startHistoryId, history: [] };
    },
    async listMessages(_accountId: string, opts: Record<string, unknown> = {}) {
      listMessagesCalls.push(opts);
      return listMessagesQueue.shift() ?? { messages: [] };
    },
    async getMessageMetadata(_accountId: string, id: string) {
      getMessageMetadataCalls.push(id);
      return messageMetadata;
    },
    async ensureWatch() {
      return null; // no watch renewal — bumps go through the plain path
    },
  };
});

const enqueueCalls: Array<{ accountId: string; userId: string; ids: string[]; priority: number }> =
  [];
vi.mock("./enqueue", () => ({
  async enqueueMessageJobs(accountId: string, userId: string, ids: string[], priority = 0) {
    enqueueCalls.push({ accountId, userId, ids: [...ids], priority });
  },
}));

const backfillRecentCalls: Array<unknown[]> = [];
vi.mock("./backfill", () => ({
  async backfillRecent(...args: unknown[]) {
    backfillRecentCalls.push(args);
  },
}));

const recordManualMoveCalls: Array<{ folderId: string; gmailMessageId: string }> = [];
vi.mock("./folder-learn", () => ({
  async recordManualMove(
    folder: { id: string },
    _accountId: string,
    _userId: string,
    email: { gmail_message_id: string },
  ) {
    recordManualMoveCalls.push({ folderId: folder.id, gmailMessageId: email.gmail_message_id });
  },
}));

vi.mock("../log.server", () => ({
  logError: () => {},
  logInfo: () => {},
  newRunId: () => "test-run",
}));

import { GmailApiError } from "../gmail.server";
import { syncSinceHistory } from "./history";

const ACC = "acc-1";
const USER = "user-1";

function seedAccount(over: Record<string, unknown> = {}) {
  fake.seed("gmail_accounts", [
    {
      id: ACC,
      user_id: USER,
      email_address: "a@x.com",
      history_id: "1000",
      watch_expiration: null,
      ...over,
    },
  ]);
}

function seedFolder(over: Record<string, unknown> = {}) {
  fake.seed("folders", [
    { id: "folder-A", gmail_account_id: ACC, gmail_label_id: "L-A", name: "A", ...over },
  ]);
}

function accountUpdates() {
  return fake.calls.updates.filter((u) => u.table === "gmail_accounts");
}
function emailUpdates() {
  return fake.calls.updates.filter((u) => u.table === "emails");
}

beforeEach(() => {
  fake.reset();
  listHistoryCalls.length = 0;
  listHistoryQueue.length = 0;
  listMessagesCalls.length = 0;
  listMessagesQueue.length = 0;
  getMessageMetadataCalls.length = 0;
  messageMetadata = {};
  enqueueCalls.length = 0;
  backfillRecentCalls.length = 0;
  recordManualMoveCalls.length = 0;
});

describe("error taxonomy", () => {
  it("404 (history expired) nulls history_id and reports rebootstrapped", async () => {
    seedAccount();
    listHistoryQueue.push(new GmailApiError("history 404", 404, false));
    const res = await syncSinceHistory(ACC);
    expect(res).toMatchObject({ rebootstrapped: true, error: "history 404" });
    const nulled = accountUpdates().filter(
      (u) => (u.payload as Record<string, unknown>).history_id === null,
    );
    expect(nulled).toHaveLength(1);
  });

  it("429/transient errors return the error WITHOUT clearing history_id", async () => {
    seedAccount();
    listHistoryQueue.push(new GmailApiError("rate limited", 429, true));
    const res = await syncSinceHistory(ACC);
    expect(res).toEqual({ error: "rate limited" });
    // Clearing the cursor on a transient failure would trigger an expensive
    // full-mailbox bootstrap on the next push. Never do it.
    expect(accountUpdates().every((u) => !("history_id" in (u.payload as object)))).toBe(true);
  });
});

describe("history event handling", () => {
  it("batches messagesDeleted into a single delete statement", async () => {
    seedAccount();
    listHistoryQueue.push({
      historyId: "1100",
      history: [
        { messagesDeleted: [{ message: { id: "d1" } }, { message: { id: "d2" } }] },
        { messagesDeleted: [{ message: { id: "d3" } }] },
      ],
    });
    await syncSinceHistory(ACC);
    const deletes = fake.calls.deletes.filter((d) => d.table === "emails");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].filters).toEqual([
      { op: "eq", col: "gmail_account_id", value: ACC },
      { op: "in", col: "gmail_message_id", value: ["d1", "d2", "d3"] },
    ]);
  });

  it("a TRASH label add deletes the local row instead of patching labels", async () => {
    seedAccount();
    listHistoryQueue.push({
      historyId: "1100",
      history: [
        {
          labelsAdded: [{ message: { id: "m-trash", labelIds: ["TRASH"] }, labelIds: ["TRASH"] }],
        },
      ],
    });
    await syncSinceHistory(ACC);
    const deletes = fake.calls.deletes.filter((d) => d.table === "emails");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].filters).toEqual([
      { op: "eq", col: "gmail_account_id", value: ACC },
      { op: "eq", col: "gmail_message_id", value: "m-trash" },
    ]);
    expect(emailUpdates()).toHaveLength(0);
  });

  it("a TRASH removal with no local row re-ingests through the queue", async () => {
    seedAccount();
    listHistoryQueue.push({
      historyId: "1100",
      history: [
        {
          labelsRemoved: [
            { message: { id: "m-restored", labelIds: ["INBOX"] }, labelIds: ["TRASH"] },
          ],
        },
      ],
    });
    await syncSinceHistory(ACC);
    // The row was deleted when it was trashed — an UPDATE would no-op, so
    // the message goes back through the normal ingest pipeline.
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toMatchObject({ accountId: ACC, userId: USER, ids: ["m-restored"] });
    expect(emailUpdates()).toHaveLength(0);
  });

  it("a folder-label add patches folder_id + gmail_labeled and records the manual move", async () => {
    seedAccount();
    seedFolder();
    fake.seed("emails", [
      { id: "row-1", gmail_account_id: ACC, gmail_message_id: "m-1", folder_id: null },
    ]);
    listHistoryQueue.push({
      historyId: "1100",
      history: [
        {
          labelsAdded: [{ message: { id: "m-1", labelIds: ["INBOX"] }, labelIds: ["L-A"] }],
        },
      ],
    });
    await syncSinceHistory(ACC);
    expect(emailUpdates()).toHaveLength(1);
    expect(emailUpdates()[0].payload).toEqual({
      raw_labels: ["INBOX", "L-A"],
      folder_id: "folder-A",
      classified_by: "gmail_labeled",
    });
    expect(recordManualMoveCalls).toEqual([{ folderId: "folder-A", gmailMessageId: "m-1" }]);
    // Quota-spiral guard: this path must never round-trip to Gmail.
    expect(getMessageMetadataCalls).toHaveLength(0);
  });

  it("skips recordManualMove when no local row exists — and still never fetches metadata", async () => {
    seedAccount();
    seedFolder();
    listHistoryQueue.push({
      historyId: "1100",
      history: [
        {
          labelsAdded: [{ message: { id: "m-unknown", labelIds: ["INBOX"] }, labelIds: ["L-A"] }],
        },
      ],
    });
    await syncSinceHistory(ACC);
    expect(recordManualMoveCalls).toHaveLength(0);
    expect(getMessageMetadataCalls).toHaveLength(0);
  });

  it("clears folder_id on label removal ONLY when the current folder matches", async () => {
    seedAccount();
    seedFolder();
    fake.seed("emails", [
      { id: "row-1", gmail_account_id: ACC, gmail_message_id: "m-match", folder_id: "folder-A" },
      { id: "row-2", gmail_account_id: ACC, gmail_message_id: "m-other", folder_id: "folder-B" },
    ]);
    listHistoryQueue.push({
      historyId: "1100",
      history: [
        {
          labelsRemoved: [
            { message: { id: "m-match", labelIds: ["INBOX", "L-A"] }, labelIds: ["L-A"] },
            { message: { id: "m-other", labelIds: ["INBOX", "L-A"] }, labelIds: ["L-A"] },
          ],
        },
      ],
    });
    await syncSinceHistory(ACC);
    expect(emailUpdates()).toHaveLength(2);
    const patchFor = (id: string) =>
      emailUpdates().find((u) =>
        u.filters.some((f) => f.col === "gmail_message_id" && f.value === id),
      )?.payload as Record<string, unknown>;
    // Matching folder → dropped out of it.
    expect(patchFor("m-match")).toEqual({
      raw_labels: ["INBOX"],
      folder_id: null,
      classified_by: "gmail_unlabeled",
    });
    // The user filed m-other elsewhere in the meantime — respect it.
    expect(patchFor("m-other")).toEqual({ raw_labels: ["INBOX"] });
  });

  it("skips label ops for messages in seenAdded (row not inserted yet)", async () => {
    seedAccount();
    seedFolder();
    listHistoryQueue.push({
      historyId: "1100",
      history: [
        { messagesAdded: [{ message: { id: "m-new", labelIds: ["INBOX"] } }] },
        {
          labelsAdded: [{ message: { id: "m-new", labelIds: ["INBOX"] }, labelIds: ["L-A"] }],
        },
      ],
    });
    const res = await syncSinceHistory(ACC);
    expect(res).toEqual({ synced: 1 });
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0].ids).toEqual(["m-new"]);
    // The queued processGmailMessage will read the final labels itself; an
    // UPDATE now would silently no-op against a row that doesn't exist.
    expect(emailUpdates()).toHaveLength(0);
  });

  it("caps pagination at 25 pages even when Gmail keeps returning tokens", async () => {
    seedAccount();
    for (let i = 0; i < 30; i++) {
      listHistoryQueue.push({ historyId: String(1100 + i), history: [], nextPageToken: "MORE" });
    }
    await syncSinceHistory(ACC);
    expect(listHistoryCalls).toHaveLength(25);
  });

  it("enqueues each page's new mail and advances the cursor to the per-record id before moving on", async () => {
    // The email-loss-race fix: a page's adds are made durable (enqueued) and
    // the cursor is bumped to that page's highest history RECORD id BEFORE the
    // walk continues — so a mid-walk death (worker kill / quota 403 on a later
    // page) can never leave the cursor ahead of un-enqueued mail. The cursor
    // must track the per-record id, NOT the response-level historyId (which is
    // the mailbox's CURRENT head on every page).
    seedAccount({ history_id: "1000" });
    listHistoryQueue.push({
      historyId: "1100", // mailbox head — must NOT be the mid-walk cursor value
      history: [{ id: "1010", messagesAdded: [{ message: { id: "m1", labelIds: ["INBOX"] } }] }],
      nextPageToken: "P2",
    });
    listHistoryQueue.push({
      historyId: "1100",
      history: [{ id: "1020", messagesAdded: [{ message: { id: "m2", labelIds: ["INBOX"] } }] }],
    });

    await syncSinceHistory(ACC);

    // Per-page enqueue (not one bulk enqueue at the end): each page's ids land
    // in their own call, in page order.
    expect(enqueueCalls).toHaveLength(2);
    expect(enqueueCalls[0].ids).toEqual(["m1"]);
    expect(enqueueCalls[1].ids).toEqual(["m2"]);

    // The cursor is bumped to the per-record ids 1010 then 1020 (not 1100),
    // and the end-of-walk head bump to 1100 lands last. bump_history_id_if_greater
    // is monotonic, so the sequence never regresses.
    const bumps = fake.calls.rpcs
      .filter((r) => r.fn === "bump_history_id_if_greater")
      .map((r) => String((r.args as { p_new_history_id: unknown }).p_new_history_id));
    expect(bumps).toContain("1010");
    expect(bumps).toContain("1020");
    // The mid-walk cursor advanced to a record id before the head was ever stamped.
    expect(bumps.indexOf("1010")).toBeLessThan(bumps.indexOf("1100"));
  });
});

describe("bootstrap (history_id null)", () => {
  it("anchors to the newest local email, dedupes against local rows, and bumps from metadata", async () => {
    seedAccount({ history_id: null });
    const anchorIso = "2026-07-01T12:00:00.000Z";
    fake.seed("emails", [
      {
        id: "row-old",
        gmail_account_id: ACC,
        gmail_message_id: "have-1",
        received_at: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "row-new",
        gmail_account_id: ACC,
        gmail_message_id: "have-2",
        received_at: anchorIso,
      },
    ]);
    // Page of candidates (with a duplicate id), then the historyId probe.
    listMessagesQueue.push({
      messages: [{ id: "have-1" }, { id: "new-1" }, { id: "new-1" }, { id: "new-2" }],
    });
    listMessagesQueue.push({ messages: [{ id: "probe" }] });
    messageMetadata = { historyId: "9999" };

    const res = await syncSinceHistory(ACC);
    expect(res).toEqual({ bootstrapped: true });

    const anchorSecs = Math.floor(new Date(anchorIso).getTime() / 1000);
    expect(listMessagesCalls[0]).toMatchObject({
      q: `after:${anchorSecs} -in:chats -in:trash -in:spam`,
      maxResults: 100,
    });
    // Locally-present ids are filtered; duplicates collapse to one.
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0].ids).toEqual(["new-1", "new-2"]);
    // historyId probe uses the light metadata fetch and the monotonic RPC.
    expect(getMessageMetadataCalls).toEqual(["probe"]);
    const bump = fake.calls.rpcs.find((r) => r.fn === "bump_history_id_if_greater");
    expect(bump?.args).toMatchObject({ p_account_id: ACC, p_new_history_id: "9999" });
    expect(backfillRecentCalls).toHaveLength(0);
  });

  it("falls back to backfillRecent when the account has no local mail at all", async () => {
    seedAccount({ history_id: null });
    listMessagesQueue.push({ messages: [] }); // the historyId probe finds nothing
    const res = await syncSinceHistory(ACC);
    expect(res).toEqual({ bootstrapped: true });
    expect(backfillRecentCalls).toEqual([[ACC, USER, 100]]);
    expect(enqueueCalls).toHaveLength(0);
  });
});

describe("history_id bump fallback and stamping", () => {
  it("falls back to the JS monotonic check when the bump RPC errors", async () => {
    seedAccount({ history_id: "1000" });
    fake.onRpc("bump_history_id_if_greater", () => ({
      error: { message: "function does not exist" },
    }));
    listHistoryQueue.push({ historyId: "2000", history: [] });
    await syncSinceHistory(ACC);
    // 2000 > 1000 → the fallback writes the raw update (worse than the RPC
    // under concurrency, but strictly better than a blind UPDATE).
    const raw = accountUpdates().filter((u) => "history_id" in (u.payload as object));
    expect(raw.length).toBeGreaterThanOrEqual(1);
    expect(raw[0].payload).toMatchObject({ history_id: "2000" });
  });

  it("does not regress history_id via the JS fallback when the stored id is higher", async () => {
    seedAccount({ history_id: "3000" });
    fake.onRpc("bump_history_id_if_greater", () => ({
      error: { message: "function does not exist" },
    }));
    listHistoryQueue.push({ historyId: "2000", history: [] });
    await syncSinceHistory(ACC);
    expect(accountUpdates().filter((u) => "history_id" in (u.payload as object))).toHaveLength(0);
  });

  it("stamps last_push_at only for push-initiated syncs (publishedAtMs set)", async () => {
    seedAccount();
    listHistoryQueue.push({ historyId: "1100", history: [] });
    await syncSinceHistory(ACC, { publishedAtMs: Date.now() });
    const pushStamp = accountUpdates().find((u) => "last_history_sync_at" in (u.payload as object));
    expect(pushStamp?.payload).toMatchObject({
      last_history_sync_at: expect.any(String),
      last_push_at: expect.any(String),
    });
  });

  it("poll-initiated syncs stamp last_history_sync_at but never last_push_at", async () => {
    seedAccount();
    listHistoryQueue.push({ historyId: "1100", history: [] });
    await syncSinceHistory(ACC);
    const stamp = accountUpdates().find((u) => "last_history_sync_at" in (u.payload as object));
    expect(stamp).toBeDefined();
    // Stamping last_push_at on polls would defeat the poll cron's
    // "push has gone silent" detection.
    expect("last_push_at" in (stamp!.payload as object)).toBe(false);
  });
});
