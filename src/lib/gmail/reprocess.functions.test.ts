// Unit tests for the reprocess / reanalyze server functions — audit path 6 in
// docs/rules-engine-audit.md §1 ("Reprocess / reanalyze — own precedence,
// clears then refiles"). These paths write emails.folder_id OUTSIDE the
// single-writer pipeline, so the contracts pinned here are:
//
//   - ownership scoping: every read/write is scoped to context.userId (or an
//     owned gmail account); an impersonated caller touches nothing;
//   - the clear-then-refile shape: stripFolderLabelPast clears folder_id →
//     null / classified_by "manual_strip" and mirrors the label removal to
//     Gmail; searchGmailAndIngest refiles ingested mail through
//     classifyIngestedMessage and writes folder_id via the encrypted writer;
//   - batching: Gmail search pages 2×100 and skips already-known message ids;
//   - one failing row never aborts a batch (strip workers, ingest workers,
//     reconcile repair loop) — only a Gmail rate-limit stops early;
//   - a message deleted in Gmail (404 → getMessageLabels null / getMessage
//     throw) deletes the local row (resync/reconcile) or is skipped (ingest).
//
// The reanalyzeEmail characterization at the bottom covers the audit §2
// finding for this same path 6 (the function itself now lives in
// move.functions.ts): reanalyze re-derives with skipGmailLabelMatch, so a
// message previously filed BY GMAIL LABEL can silently change folder.
//
// Harness: __fixtures__/server-fn-stub makes each createServerFn export a
// plain callable with context.userId = TEST_USER (overridable per call for
// impersonation checks); __fixtures__/supabase-fake backs supabaseAdmin.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";

const fake = makeSupabaseFake();

// -- Harness: the createServerFn chain becomes a plain callable ------------
vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHost: vi.fn(() => "localhost:3000"),
}));
// The stub ignores middleware; this export only needs to exist for the import.
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));

// -- DB: shared chainable fake (hoist-safe wrapper) ------------------------
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

// -- Gmail API surface (pure helpers like ingest-classify stay real) --------
const modifyMessage = vi.fn(async (..._args: unknown[]) => ({}));
const listMessages = vi.fn(
  async (
    _accountId: string,
    _opts: Record<string, unknown>,
  ): Promise<{ messages?: Array<{ id: string; threadId?: string }>; nextPageToken?: string }> => ({
    messages: [],
  }),
);
const getMessage = vi.fn(async (_accountId: string, id: string): Promise<{ id: string }> => ({
  id,
}));
const getMessageLabels = vi.fn(
  async (_accountId: string, _id: string): Promise<string[] | null> => [],
);
const parseMessage = vi.fn((_raw: unknown): Record<string, unknown> => ({}));
vi.mock("../gmail.server", () => ({
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  modifyMessage: (...args: unknown[]) => modifyMessage(...args),
  batchModifyMessages: vi.fn(),
  trashMessage: vi.fn(),
  sendMessage: vi.fn(),
  ensureWatch: vi.fn(),
  stopWatch: vi.fn(),
  listMessages: (accountId: string, opts: Record<string, unknown>) => listMessages(accountId, opts),
  getMessage: (accountId: string, id: string) => getMessage(accountId, id),
  getMessageMetadata: vi.fn(),
  getMessageLabels: (accountId: string, id: string) => getMessageLabels(accountId, id),
  getThread: vi.fn(),
  parseMessage: (raw: unknown) => parseMessage(raw),
}));

const enqueueMessageJob = vi.fn(async (_acc: string, _user: string, _id: string) => undefined);
const classifyParsedEmail = vi.fn(
  async (
    _parsed: unknown,
    _userId: string,
    _accountId: string,
    _opts: unknown,
  ): Promise<Record<string, unknown>> => ({ folder_id: null, classified_by: "none" }),
);
const loadAccountContext = vi.fn(
  async (_accountId: string, _userId: string): Promise<Record<string, unknown>> => ({
    folders: [],
    filters: [],
  }),
);
vi.mock("../sync.server", () => ({
  backfillRecent: vi.fn(),
  backfillWindow: vi.fn(),
  syncSinceHistory: vi.fn(),
  learnFromLinkedLabel: vi.fn(),
  reconcileLocalInbox: vi.fn(),
  loadOlderFromLabel: vi.fn(),
  runMessageJobs: vi.fn(),
  retryMessageJob: vi.fn(),
  enqueueMessageJob: (acc: string, user: string, id: string) => enqueueMessageJob(acc, user, id),
  startBackfillJob: vi.fn(),
  cancelBackfillJob: vi.fn(),
  invalidateAccountContext: vi.fn(),
  invalidateAccountContextForUser: vi.fn(),
  bulkCatchupClaim: vi.fn(),
  syncReadState: vi.fn(),
  classifyParsedEmail: (parsed: unknown, userId: string, accountId: string, opts: unknown) =>
    classifyParsedEmail(parsed, userId, accountId, opts),
  loadAccountContext: (accountId: string, userId: string) => loadAccountContext(accountId, userId),
}));

// move.functions.ts (reanalyzeEmail) pulls these in too.
vi.mock("../move-email.server", () => ({
  performMove: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../ai.server", () => ({
  suggestReply: vi.fn(),
  summarizeEmail: vi.fn(async () => "summary"),
}));

vi.mock("../log.server", () => ({
  logError: () => {},
  logInfo: () => {},
  logAudit: () => {},
}));

const upsertEmailEncrypted = vi.fn(
  async (input: {
    gmail_message_id: string;
  }): Promise<{ id: string | null; error: string | null }> => ({
    id: `db-${input.gmail_message_id}`,
    error: null,
  }),
);
const updateEmailEncrypted = vi.fn(async (_input: unknown) => ({ error: null as string | null }));
vi.mock("../sync/encrypted-writer", () => ({
  upsertEmailEncrypted: (input: { gmail_message_id: string }) => upsertEmailEncrypted(input),
  updateEmailEncrypted: (input: unknown) => updateEmailEncrypted(input),
  setReplyDraftEncrypted: vi.fn(),
  insertFolderExampleEncrypted: vi.fn(),
}));

const getEmailsDecrypted = vi.fn(
  async (_ids: string[]): Promise<{ rows: Array<Record<string, unknown>>; error: null }> => ({
    rows: [],
    error: null,
  }),
);
vi.mock("../sync/encrypted-reader", () => ({
  getEmailsDecrypted: (ids: string[]) => getEmailsDecrypted(ids),
}));

import {
  stripFolderLabelPast,
  searchGmailAndIngest,
  resyncMessage,
  reconcileInboxFromGmail,
} from "./reprocess.functions";
import { reanalyzeEmail } from "./move.functions";

const ACC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMAIL_1 = "11111111-1111-4111-8111-111111111111";
const EMAIL_2 = "22222222-2222-4222-8222-222222222222";
const EMAIL_3 = "33333333-3333-4333-8333-333333333333";
const EMAIL_4 = "44444444-4444-4444-8444-444444444444";
const FOLDER_A = "55555555-5555-4555-8555-555555555555";
const FOLDER_B = "66666666-6666-4666-8666-666666666666";
const FOLDER_C = "77777777-7777-4777-8777-777777777777";

/** A complete-enough folders row for the REAL filter engine to walk. */
function folderRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: TEST_USER,
    name: `folder-${id.slice(0, 4)}`,
    gmail_label_id: null,
    gmail_account_id: ACC,
    processing_enabled: true,
    priority: 0,
    filter_logic: "any",
    filter_tree: null,
    run_on_threads: false,
    ...over,
  };
}

beforeEach(() => {
  fake.reset();
  for (const fn of [
    modifyMessage,
    listMessages,
    getMessage,
    getMessageLabels,
    parseMessage,
    enqueueMessageJob,
    classifyParsedEmail,
    loadAccountContext,
    upsertEmailEncrypted,
    updateEmailEncrypted,
    getEmailsDecrypted,
  ])
    fn.mockClear();
  modifyMessage.mockResolvedValue({});
  listMessages.mockResolvedValue({ messages: [] });
  getMessage.mockImplementation(async (_acc, id) => ({ id }));
  getMessageLabels.mockResolvedValue([]);
  parseMessage.mockImplementation(() => ({}));
  enqueueMessageJob.mockResolvedValue(undefined);
  upsertEmailEncrypted.mockImplementation(async (input) => ({
    id: `db-${input.gmail_message_id}`,
    error: null,
  }));
  updateEmailEncrypted.mockResolvedValue({ error: null });
  getEmailsDecrypted.mockResolvedValue({ rows: [], error: null });
});

describe("stripFolderLabelPast", () => {
  it("scopes the sweep to the caller: another user's rows with the same domain are untouched", async () => {
    fake.seed("emails", [
      {
        id: EMAIL_1,
        user_id: TEST_USER,
        gmail_message_id: "gm-1",
        gmail_account_id: ACC,
        folder_id: FOLDER_A,
        from_addr: "jane@acme.com",
        raw_labels: ["INBOX", "L-A"],
      },
      {
        id: EMAIL_2,
        user_id: "someone-else",
        gmail_message_id: "gm-2",
        gmail_account_id: "acc-other",
        folder_id: FOLDER_A,
        from_addr: "jane@acme.com",
        raw_labels: ["INBOX", "L-A"],
      },
    ]);
    fake.seed("folders", [folderRow(FOLDER_A, { gmail_label_id: "L-A" })]);

    const res = await stripFolderLabelPast({
      data: { value: "acme.com", match_type: "domain" },
    });
    expect(res).toEqual({ ok: true, stripped_count: 1 });

    // The candidate query itself carries the user_id scope...
    expect(fake.calls.selects[0]!.table).toBe("emails");
    expect(fake.calls.selects[0]!.filters).toContainEqual({
      op: "eq",
      col: "user_id",
      value: TEST_USER,
    });
    // ...and only the caller's row is cleared.
    const updates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.filters).toEqual([{ op: "eq", col: "id", value: EMAIL_1 }]);
  });

  it("clears then refiles nothing: folder_id → null, manual_strip, archived derived from INBOX, Gmail label removed", async () => {
    // No INBOX in raw_labels → the strip marks the row archived.
    fake.seed("emails", [
      {
        id: EMAIL_1,
        user_id: TEST_USER,
        gmail_message_id: "gm-1",
        gmail_account_id: ACC,
        folder_id: FOLDER_A,
        from_addr: "jane@acme.com",
        raw_labels: ["L-A"],
      },
    ]);
    fake.seed("folders", [folderRow(FOLDER_A, { gmail_label_id: "L-A" })]);

    const res = await stripFolderLabelPast({
      data: { value: "jane@acme.com", match_type: "email" },
    });
    expect(res).toEqual({ ok: true, stripped_count: 1 });

    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: EMAIL_1,
      classification_reason: "Right-click: removed folder label",
      ai_summary: "",
    });
    const updates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toEqual({
      folder_id: null,
      is_archived: true,
      classified_by: "manual_strip",
      matched_filter_ids: [],
    });
    // The old folder's Gmail label is removed from the message.
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-1", [], ["L-A"]);
  });

  it("re-checks the ilike prefilter with emailDomain: a lookalike domain is not stripped", async () => {
    fake.seed("emails", [
      {
        id: EMAIL_1,
        user_id: TEST_USER,
        gmail_message_id: "gm-1",
        gmail_account_id: ACC,
        folder_id: FOLDER_A,
        // Unnormalized header form still matches (emailDomain → acme.com)...
        from_addr: "Jane <jane@acme.com> (Sales)",
        raw_labels: ["INBOX"],
      },
      {
        id: EMAIL_2,
        user_id: TEST_USER,
        gmail_message_id: "gm-2",
        gmail_account_id: ACC,
        folder_id: FOLDER_A,
        // ...but a domain that merely CONTAINS "@acme.com" does not.
        from_addr: "x@acme.com.evil.com",
        raw_labels: ["INBOX"],
      },
    ]);
    fake.seed("folders", [folderRow(FOLDER_A)]);

    const res = await stripFolderLabelPast({
      data: { value: "@Acme.COM", match_type: "domain" },
    });
    expect(res).toEqual({ ok: true, stripped_count: 1 });
    const updates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.filters).toEqual([{ op: "eq", col: "id", value: EMAIL_1 }]);
  });

  it("a failing row is logged and skipped — the rest of the batch still strips", async () => {
    fake.seed("emails", [
      {
        id: EMAIL_1,
        user_id: TEST_USER,
        gmail_message_id: "gm-1",
        gmail_account_id: ACC,
        folder_id: FOLDER_A,
        from_addr: "a@acme.com",
        raw_labels: ["INBOX"],
      },
      {
        id: EMAIL_2,
        user_id: TEST_USER,
        gmail_message_id: "gm-2",
        gmail_account_id: ACC,
        folder_id: FOLDER_A,
        from_addr: "b@acme.com",
        raw_labels: ["INBOX"],
      },
    ]);
    fake.seed("folders", [folderRow(FOLDER_A)]);
    // First row's encrypted write blows up; worker catches and moves on.
    updateEmailEncrypted.mockRejectedValueOnce(new Error("boom"));

    const res = await stripFolderLabelPast({
      data: { value: "acme.com", match_type: "domain" },
    });
    expect(res).toEqual({ ok: true, stripped_count: 1 });
    const updates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.filters).toEqual([{ op: "eq", col: "id", value: EMAIL_2 }]);
  });
});

describe("searchGmailAndIngest", () => {
  it("refuses an account_id owned by another user before touching Gmail", async () => {
    fake.seed("gmail_accounts", [{ id: ACC, user_id: "someone-else" }]);
    await expect(
      searchGmailAndIngest({ data: { query: "acme.com", account_id: ACC } }),
    ).rejects.toThrow("Not authorized for this account");
    expect(listMessages).not.toHaveBeenCalled();
    expect(upsertEmailEncrypted).not.toHaveBeenCalled();
  });

  it("pages Gmail search 2×100, skips already-known ids, and ingests the rest unfiled", async () => {
    fake.seed("gmail_accounts", [{ id: ACC, user_id: TEST_USER }]);
    // m1 already exists locally → not fetched again.
    fake.seed("emails", [{ id: EMAIL_1, user_id: TEST_USER, gmail_message_id: "m1" }]);
    listMessages
      .mockResolvedValueOnce({
        messages: [
          { id: "m1", threadId: "t" },
          { id: "m2", threadId: "t" },
        ],
        nextPageToken: "page2",
      })
      .mockResolvedValueOnce({ messages: [{ id: "m3", threadId: "t" }] });
    parseMessage.mockImplementation((raw) => {
      const { id } = raw as { id: string };
      return {
        gmail_message_id: id,
        thread_id: "t",
        from_addr: `${id}@x.com`,
        from_name: null,
        to_addrs: null,
        subject: "s",
        snippet: "",
        body_text: "",
        body_html: "",
        received_at: "2026-01-01T00:00:00Z",
        is_read: false,
        has_attachment: false,
        raw_labels: ["INBOX"],
      };
    });

    const res = await searchGmailAndIngest({ data: { query: "acme.com", account_id: ACC } });

    // Domain-looking query becomes a from: search, paged with the token.
    expect(listMessages).toHaveBeenNthCalledWith(1, ACC, {
      q: "from:acme.com",
      maxResults: 100,
      pageToken: undefined,
    });
    expect(listMessages).toHaveBeenNthCalledWith(2, ACC, {
      q: "from:acme.com",
      maxResults: 100,
      pageToken: "page2",
    });
    expect(getMessage).toHaveBeenCalledTimes(2); // m2, m3 only
    expect(upsertEmailEncrypted).toHaveBeenCalledTimes(2);
    // With no folders/filters, ingested rows stay unfiled with the seed tag.
    expect(upsertEmailEncrypted.mock.calls[0]![0]).toMatchObject({
      user_id: TEST_USER,
      gmail_account_id: ACC,
      classified_by: "gmail_search_ingest",
    });
    expect(updateEmailEncrypted).not.toHaveBeenCalled(); // no folder_id to write
    expect(res).toEqual({
      ingested: 2,
      found: 3,
      hit_gmail_message_ids: ["m1", "m2", "m3"],
    });
  });

  it("re-derives filing on ingest: an active linked label claims the message, but a PAUSED folder's label is ignored and rules refile it elsewhere", async () => {
    // In-module cousin of the audit §2 reanalyze finding: this path builds its
    // own precedence, so "the user filed it under folder A in Gmail" only
    // holds while A is unpaused — otherwise A's label is dropped from the
    // label→folder map and a domain rule can steal the message for B.
    fake.seed("gmail_accounts", [{ id: ACC, user_id: TEST_USER }]);
    fake.seed("folders", [
      folderRow(FOLDER_A, { gmail_label_id: "L-A", processing_enabled: false, name: "Paused" }),
      folderRow(FOLDER_B, { name: "Rules" }),
      folderRow(FOLDER_C, { gmail_label_id: "L-C", name: "Linked" }),
    ]);
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_B, field: "domain", op: "contains", value: "acme.com" },
    ]);
    listMessages.mockResolvedValueOnce({
      messages: [
        { id: "m8", threadId: "t" },
        { id: "m9", threadId: "t" },
      ],
    });
    parseMessage.mockImplementation((raw) => {
      const { id } = raw as { id: string };
      return {
        gmail_message_id: id,
        thread_id: "t",
        from_addr: "news@acme.com",
        from_name: null,
        to_addrs: null,
        subject: "s",
        snippet: "",
        body_text: "",
        body_html: "",
        received_at: "2026-01-01T00:00:00Z",
        is_read: false,
        has_attachment: false,
        // m8 carries the ACTIVE folder C label; m9 the PAUSED folder A label.
        raw_labels: id === "m8" ? ["L-C"] : ["L-A"],
      };
    });

    const res = await searchGmailAndIngest({ data: { query: "acme.com", account_id: ACC } });
    expect(res).toMatchObject({ ingested: 2, found: 2 });

    const folderWrites = updateEmailEncrypted.mock.calls.map((c) => c[0]);
    expect(folderWrites).toContainEqual({
      email_id: "db-m8",
      folder_id: FOLDER_C, // linked label wins for the active folder
      ai_confidence: 1,
      classification_reason: "Matched Gmail label",
    });
    expect(folderWrites).toContainEqual({
      email_id: "db-m9",
      folder_id: FOLDER_B, // paused A's label ignored → domain rule refiles
      ai_confidence: 1,
      classification_reason: "Domain rule: acme.com",
    });
  });

  it("a message that 404s (deleted in Gmail) is skipped and the batch continues", async () => {
    fake.seed("gmail_accounts", [{ id: ACC, user_id: TEST_USER }]);
    listMessages.mockResolvedValueOnce({
      messages: [
        { id: "m2", threadId: "t" },
        { id: "m3", threadId: "t" },
      ],
    });
    getMessage.mockImplementation(async (_acc, id) => {
      if (id === "m2") throw new Error("Gmail API error 404: Not Found");
      return { id };
    });
    parseMessage.mockImplementation((raw) => ({
      gmail_message_id: (raw as { id: string }).id,
      thread_id: "t",
      from_addr: "a@x.com",
      from_name: null,
      to_addrs: null,
      subject: "s",
      snippet: "",
      body_text: "",
      body_html: "",
      received_at: "2026-01-01T00:00:00Z",
      is_read: false,
      has_attachment: false,
      raw_labels: [],
    }));

    const res = await searchGmailAndIngest({ data: { query: "acme.com", account_id: ACC } });
    // 404 row logged + skipped; no rate_limited / reauth reason reported.
    expect(res).toEqual({ ingested: 1, found: 2, hit_gmail_message_ids: ["m2", "m3"] });
  });

  it("a Gmail rate-limit stops the batch early and reports reason: rate_limited", async () => {
    fake.seed("gmail_accounts", [{ id: ACC, user_id: TEST_USER }]);
    listMessages.mockResolvedValueOnce({ messages: [{ id: "m2", threadId: "t" }] });
    getMessage.mockRejectedValue(new Error("rateLimitExceeded"));

    const res = await searchGmailAndIngest({ data: { query: "acme.com", account_id: ACC } });
    expect(res).toEqual({
      ingested: 0,
      found: 1,
      hit_gmail_message_ids: ["m2"],
      reason: "rate_limited",
    });
    expect(upsertEmailEncrypted).not.toHaveBeenCalled();
  });
});

describe("resyncMessage", () => {
  it("denies an impersonated caller before any Gmail call or write", async () => {
    fake.seed("emails", [
      {
        id: EMAIL_1,
        user_id: TEST_USER,
        gmail_message_id: "gm-1",
        gmail_account_id: ACC,
        from_addr: "a@x.com",
        thread_id: "t",
      },
    ]);
    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(resyncMessage, "intruder")({ data: { id: EMAIL_1 } }),
      rejects: "Not authorized",
    });
    expect(getMessageLabels).not.toHaveBeenCalled();
  });

  it("deletes the local row when Gmail says the message is gone (404 → null labels)", async () => {
    fake.seed("emails", [
      {
        id: EMAIL_1,
        user_id: TEST_USER,
        gmail_message_id: "gm-1",
        gmail_account_id: ACC,
        from_addr: "a@x.com",
        thread_id: "t",
      },
    ]);
    getMessageLabels.mockResolvedValueOnce(null);

    const res = await resyncMessage({ data: { id: EMAIL_1 } });
    expect(res).toEqual({ deleted: true });
    const deletes = fake.calls.deletes.filter((d) => d.table === "emails");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.filters).toEqual([{ op: "eq", col: "id", value: EMAIL_1 }]);
  });
});

describe("reconcileInboxFromGmail", () => {
  it("refuses an account the caller does not own", async () => {
    fake.seed("gmail_accounts", [{ id: ACC, user_id: "someone-else" }]);
    await expect(reconcileInboxFromGmail({ data: { gmail_account_id: ACC } })).rejects.toThrow(
      "Not authorized for this account",
    );
    expect(listMessages).not.toHaveBeenCalled();
  });

  it("repairs drifted rows from Gmail truth: archives, deletes 404s, and survives a per-row failure", async () => {
    fake.seed("gmail_accounts", [{ id: ACC, user_id: TEST_USER }]);
    const row = (id: string, gm: string, at: string) => ({
      id,
      user_id: TEST_USER,
      gmail_account_id: ACC,
      gmail_message_id: gm,
      received_at: at,
      is_archived: false,
      raw_labels: ["INBOX"],
    });
    fake.seed("emails", [
      row(EMAIL_1, "g1", "2026-01-04T00:00:00Z"), // still in Gmail inbox
      row(EMAIL_2, "g2", "2026-01-03T00:00:00Z"), // archived in Gmail
      row(EMAIL_3, "g3", "2026-01-02T00:00:00Z"), // deleted in Gmail (404)
      row(EMAIL_4, "g4", "2026-01-01T00:00:00Z"), // labels fetch blows up
    ]);
    listMessages.mockResolvedValueOnce({ messages: [{ id: "g1" }] });
    getMessageLabels.mockImplementation(async (_acc, id) => {
      if (id === "g2") return ["Label_X"]; // no INBOX → archived
      if (id === "g3") return null; // 404 → delete
      throw new Error("network");
    });

    const res = await reconcileInboxFromGmail({ data: { gmail_account_id: ACC } });
    expect(res).toEqual({
      checked: 4,
      drifted: 3,
      reconciled: 1,
      deleted: 1,
      restored: 0,
      ingested: 0,
    });

    const updates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.filters).toEqual([{ op: "eq", col: "id", value: EMAIL_2 }]);
    expect(updates[0]!.payload).toEqual({
      raw_labels: ["Label_X"],
      is_archived: true,
      is_read: true,
    });
    const deletes = fake.calls.deletes.filter((d) => d.table === "emails");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.filters).toEqual([{ op: "eq", col: "id", value: EMAIL_3 }]);
  });

  it("incoming pass: restores locally-archived rows Gmail says are in INBOX and enqueues unknown ids", async () => {
    fake.seed("gmail_accounts", [{ id: ACC, user_id: TEST_USER }]);
    fake.seed("emails", [
      {
        id: EMAIL_1,
        user_id: TEST_USER,
        gmail_account_id: ACC,
        gmail_message_id: "g5",
        received_at: "2026-01-01T00:00:00Z",
        is_archived: true, // locally archived, but Gmail has it in INBOX
        raw_labels: ["Label_X"],
        snoozed_until: "2026-02-01T00:00:00Z",
      },
    ]);
    listMessages.mockResolvedValueOnce({ messages: [{ id: "g5" }, { id: "g6" }] });

    const res = await reconcileInboxFromGmail({ data: { gmail_account_id: ACC } });
    expect(res).toEqual({
      checked: 0,
      drifted: 0,
      reconciled: 0,
      deleted: 0,
      restored: 1,
      ingested: 1,
    });

    const updates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toEqual({
      is_archived: false,
      raw_labels: ["Label_X", "INBOX"],
      snoozed_until: null,
    });
    expect(updates[0]!.filters).toEqual([{ op: "eq", col: "id", value: EMAIL_1 }]);
    // g6 has no local row → normal ingestion pipeline, owner-scoped.
    expect(enqueueMessageJob).toHaveBeenCalledWith(ACC, TEST_USER, "g6");
  });
});

describe("reanalyzeEmail (audit path 6 — clear-then-refile precedence)", () => {
  // CHARACTERIZATION, docs/rules-engine-audit.md §2: "Reprocess re-derives
  // from rules with skipGmailLabelMatch, so a message filed by a Gmail label
  // can silently change folder on reprocess." Pinned as-is: the fix belongs
  // to Phase B (route through persistDecision), not to this test.
  it("passes skipGmailLabelMatch, so a message previously filed BY GMAIL LABEL is refiled by rules", async () => {
    getEmailsDecrypted.mockResolvedValueOnce({
      rows: [
        {
          id: EMAIL_1,
          user_id: TEST_USER,
          gmail_account_id: ACC,
          gmail_message_id: "gm-1",
          from_addr: "news@acme.com",
          from_name: "News",
          to_addrs: "me@x.com",
          subject: "s",
          snippet: "",
          body_text: "b",
          body_html: "",
          has_attachment: false,
          received_at: "2026-01-01T00:00:00Z",
          // Filed under folder A because the user labeled it in Gmail.
          raw_labels: ["L-A"],
          folder_id: FOLDER_A,
        },
      ],
      error: null,
    });
    loadAccountContext.mockResolvedValueOnce({ folders: [], filters: [] });
    // With the label match skipped, the rules ladder picks folder B instead.
    classifyParsedEmail.mockResolvedValueOnce({
      folder_id: FOLDER_B,
      classified_by: "domain_rule",
      classification_reason: "Domain rule: acme.com",
      ai_confidence: 1,
      ai_summary: "sum",
      matched_filter_ids: ["ff-1"],
    });
    fake.seed("folders", [
      folderRow(FOLDER_A, { gmail_label_id: "L-A", name: "Labeled" }),
      folderRow(FOLDER_B, { gmail_label_id: "L-B", name: "Rules" }),
    ]);

    const res = await reanalyzeEmail({ data: { email_id: EMAIL_1 } });

    expect(classifyParsedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ raw_labels: ["L-A"] }),
      TEST_USER,
      ACC,
      expect.objectContaining({ skipGmailLabelMatch: true }),
    );
    // The row is refiled away from the folder the Gmail label had chosen...
    const updates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toMatchObject({
      folder_id: FOLDER_B,
      classified_by: "domain_rule",
    });
    expect(updates[0]!.filters).toEqual([{ op: "eq", col: "id", value: EMAIL_1 }]);
    // ...and Gmail's labels are swapped to match the new answer.
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-1", ["L-B"], ["L-A"]);
    expect(res).toMatchObject({ ok: true, folder_id: FOLDER_B, changed: true });
  });

  it("denies an impersonated caller before classifying or writing", async () => {
    getEmailsDecrypted.mockResolvedValueOnce({
      rows: [
        {
          id: EMAIL_1,
          user_id: TEST_USER,
          gmail_account_id: ACC,
          gmail_message_id: "gm-1",
        },
      ],
      error: null,
    });
    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(reanalyzeEmail, "intruder")({ data: { email_id: EMAIL_1 } }),
      rejects: "Email not found",
    });
    expect(classifyParsedEmail).not.toHaveBeenCalled();
  });
});
