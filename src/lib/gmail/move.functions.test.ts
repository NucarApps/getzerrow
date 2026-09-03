// Unit tests for the move-related server functions (src/lib/gmail/move.functions.ts).
// This file also establishes the harness for testing `createServerFn` modules:
// @tanstack/react-start is mocked with the __fixtures__/server-fn-stub so each
// exported server function becomes a directly-callable async function whose
// zod validator still runs, with `context.userId = TEST_USER`.
//
// The destructive move core (performMove) is covered by move-email.server.test.ts;
// here we pin the wrapper contracts: ownership checks before any mutation,
// rule creation dedupe/normalization, tally + retag semantics, inbox label
// recomputation, and the global inbox-override promotion rules.
//
// reanalyzeEmail (folder-write path 6 in docs/rules-engine-audit.md) also
// lives here rather than in reprocess.functions.test.ts, where its tests used
// to sit. Its outcome ladder has six exits and each is pinned below. Only the
// classifier itself is stubbed — `emailVetoedForFolder` runs for real against
// seeded folder filters, so the eviction branch is decided by the real rule
// engine rather than by the mock's say-so.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";
import type { DecryptedEmail } from "../sync/encrypted-reader";
import type { ClassificationResult } from "../sync/classify";
import type { AccountContext } from "../sync/account-context";
import type { Filter } from "../sync/types";

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

// -- Import graph of move.functions.ts (pure sync/* helpers stay real) ------
const performMove = vi.fn(
  async (
    _userId: string,
    _emailId: string,
    _toFolderId: string,
    _reason?: string,
  ): Promise<{ ok: boolean; error?: string }> => ({ ok: true }),
);
vi.mock("../move-email.server", () => ({
  performMove: (...args: [string, string, string, string?]) => performMove(...args),
}));

const modifyMessage = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../gmail.server", () => ({
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  modifyMessage: (...args: unknown[]) => modifyMessage(...args),
  batchModifyMessages: vi.fn(),
  trashMessage: vi.fn(),
  sendMessage: vi.fn(),
  ensureWatch: vi.fn(),
  stopWatch: vi.fn(),
  listMessages: vi.fn(),
  getMessage: vi.fn(),
  getMessageMetadata: vi.fn(),
  getMessageLabels: vi.fn(),
  getThread: vi.fn(),
  parseMessage: vi.fn(),
}));

const invalidateAccountContextForUser = vi.fn(async (_userId: string) => undefined);
const classifyParsedEmail = vi.fn<(...args: unknown[]) => Promise<ClassificationResult>>();
const loadAccountContext = vi.fn<(...args: unknown[]) => Promise<AccountContext>>();
vi.mock("../sync.server", () => ({
  backfillRecent: vi.fn(),
  backfillWindow: vi.fn(),
  syncSinceHistory: vi.fn(),
  learnFromLinkedLabel: vi.fn(),
  reconcileLocalInbox: vi.fn(),
  loadOlderFromLabel: vi.fn(),
  runMessageJobs: vi.fn(),
  retryMessageJob: vi.fn(),
  enqueueMessageJob: vi.fn(),
  startBackfillJob: vi.fn(),
  cancelBackfillJob: vi.fn(),
  invalidateAccountContext: vi.fn(),
  invalidateAccountContextForUser: (userId: string) => invalidateAccountContextForUser(userId),
  bulkCatchupClaim: vi.fn(),
  syncReadState: vi.fn(),
  classifyParsedEmail: (...args: unknown[]) => classifyParsedEmail(...args),
  loadAccountContext: (...args: unknown[]) => loadAccountContext(...args),
}));

const summarizeEmail = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock("../ai.server", () => ({
  suggestReply: vi.fn(),
  suggestRuleUpdates: vi.fn(),
  suggestFolderFromEmails: vi.fn(),
  generateAiRuleFromPurpose: vi.fn(),
  generateAiRuleFromLabelSamples: vi.fn(),
  summarizeEmail: (...args: unknown[]) => summarizeEmail(...args),
}));

vi.mock("../summaries.server", () => ({
  computeNextRun: vi.fn(),
  enqueueFolderSummaryJob: vi.fn(),
  runFolderSummary: vi.fn(),
}));

vi.mock("../google-oauth.server", () => ({
  signState: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  getRedirectUri: vi.fn(),
}));

const logError = vi.fn<(event: string, payload: unknown, err: unknown) => void>();
vi.mock("../log.server", () => ({
  logError: (event: string, payload: unknown, err: unknown) => logError(event, payload, err),
  logInfo: () => {},
  logAudit: () => {},
}));

const updateEmailEncrypted = vi.fn(async (_input: unknown) => ({ error: null as string | null }));
vi.mock("../sync/encrypted-writer", () => ({
  upsertEmailEncrypted: vi.fn(),
  updateEmailEncrypted: (input: unknown) => updateEmailEncrypted(input),
  setReplyDraftEncrypted: vi.fn(),
  insertFolderExampleEncrypted: vi.fn(),
}));

const getEmailsDecrypted =
  vi.fn<(ids: string[]) => Promise<{ rows: DecryptedEmail[]; error: string | null }>>();
vi.mock("../sync/encrypted-reader", () => ({
  getEmailsDecrypted: (ids: string[]) => getEmailsDecrypted(ids),
}));

import {
  moveEmailToFolder,
  bulkMoveEmails,
  moveEmailToInbox,
  addInboxOverride,
  reanalyzeEmail,
} from "./move.functions";

const EMAIL_1 = "11111111-1111-4111-8111-111111111111";
const EMAIL_2 = "22222222-2222-4222-8222-222222222222";
const FOLDER_TO = "33333333-3333-4333-8333-333333333333";
const FOLDER_OLD = "44444444-4444-4444-8444-444444444444";
const ACC = "55555555-5555-4555-8555-555555555555";

/** A fully-populated decrypted row, so a test only states what it varies. */
function decryptedEmail(over: Partial<DecryptedEmail> = {}): DecryptedEmail {
  return {
    id: EMAIL_1,
    user_id: TEST_USER,
    gmail_account_id: ACC,
    gmail_message_id: "gm-1",
    thread_id: null,
    from_addr: "news@acme.com",
    from_name: "Acme News",
    to_addrs: "me@example.com",
    cc: null,
    subject: "Weekly digest",
    snippet: "snip",
    body_text: "body",
    body_html: "",
    ai_summary: null,
    classification_reason: null,
    classified_by: null,
    ai_confidence: null,
    received_at: "2026-01-01T00:00:00Z",
    is_read: false,
    is_archived: true,
    has_attachment: false,
    raw_labels: ["L-OLD"],
    folder_id: FOLDER_OLD,
    matched_filter_ids: [],
    matched_folder_ids: [],
    snoozed_until: null,
    forwarded_to: null,
    forwarded_at: null,
    list_id: null,
    in_reply_to: null,
    published_at_ms: null,
    processed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function classification(over: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    folder_id: null,
    classified_by: "ai",
    ai_confidence: 0.9,
    ai_summary: "",
    classification_reason: null,
    matched_filter_ids: [],
    matched_folder_ids: [],
    ...over,
  };
}

function accountContext(filters: Filter[] = []): AccountContext {
  return {
    folders: [],
    filters,
    overrides: [],
    overrideExceptions: [],
    enrichedFolders: [],
    calendarGuardEnabled: false,
    calendarContacts: new Set<string>(),
    accountEmail: "me@example.com",
    senderGroups: new Map<string, Set<string>>(),
  };
}

beforeEach(() => {
  fake.reset();
  performMove.mockClear();
  performMove.mockResolvedValue({ ok: true });
  modifyMessage.mockClear();
  modifyMessage.mockResolvedValue({});
  updateEmailEncrypted.mockClear();
  invalidateAccountContextForUser.mockClear();
  getEmailsDecrypted.mockResolvedValue({ rows: [], error: null });
  loadAccountContext.mockResolvedValue(accountContext());
  classifyParsedEmail.mockResolvedValue(classification());
  summarizeEmail.mockResolvedValue("fallback summary");
});

describe("moveEmailToFolder", () => {
  it("rejects an email owned by another user before calling performMove", async () => {
    fake.seed("emails", [
      { id: EMAIL_1, user_id: "someone-else", folder_id: null, from_addr: "a@x.com" },
    ]);
    await expect(
      moveEmailToFolder({ data: { email_id: EMAIL_1, to_folder_id: FOLDER_TO } }),
    ).rejects.toThrow("Email not found");
    expect(performMove).not.toHaveBeenCalled();
  });

  it("runs the zod validator (non-uuid ids never reach the handler)", async () => {
    await expect(
      moveEmailToFolder({ data: { email_id: "not-a-uuid", to_folder_id: FOLDER_TO } }),
    ).rejects.toThrow();
    expect(performMove).not.toHaveBeenCalled();
    expect(fake.calls.selects).toHaveLength(0);
  });

  it("propagates a performMove failure as a thrown error", async () => {
    fake.seed("emails", [
      { id: EMAIL_1, user_id: TEST_USER, folder_id: FOLDER_OLD, from_addr: "a@x.com" },
    ]);
    performMove.mockResolvedValueOnce({ ok: false, error: "Target folder not found" });
    await expect(
      moveEmailToFolder({ data: { email_id: EMAIL_1, to_folder_id: FOLDER_TO } }),
    ).rejects.toThrow("Target folder not found");
  });

  it("returns the pre-move folder, sender and extracted domain on success", async () => {
    fake.seed("emails", [
      { id: EMAIL_1, user_id: TEST_USER, folder_id: FOLDER_OLD, from_addr: "Sender@Foo.COM" },
    ]);
    const res = await moveEmailToFolder({
      data: { email_id: EMAIL_1, to_folder_id: FOLDER_TO },
    });
    expect(performMove).toHaveBeenCalledWith(TEST_USER, EMAIL_1, FOLDER_TO);
    expect(res).toEqual({
      ok: true,
      from_folder_id: FOLDER_OLD,
      from_addr: "Sender@Foo.COM",
      domain: "foo.com",
    });
  });
});

describe("bulkMoveEmails", () => {
  function seedTargetFolder(user = TEST_USER) {
    fake.seed("folders", [
      { id: FOLDER_TO, user_id: user, name: "Receipts", gmail_label_id: "L-TO" },
    ]);
  }

  it("verifies destination-folder ownership before creating a rule or moving", async () => {
    seedTargetFolder("someone-else");
    await expect(
      bulkMoveEmails({
        data: {
          email_ids: [EMAIL_1],
          to_folder_id: FOLDER_TO,
          create_rule: { field: "domain", value: "acme.com" },
        },
      }),
    ).rejects.toThrow("Target folder not found");
    expect(performMove).not.toHaveBeenCalled();
    expect(fake.calls.inserts).toHaveLength(0);
  });

  it("lowercases the rule value, dedupes against an existing filter, and threads the rule reason", async () => {
    seedTargetFolder();
    // An identical (lowercased) rule already exists → no second insert.
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_TO, field: "domain", op: "contains", value: "acme.com" },
    ]);
    const res = await bulkMoveEmails({
      data: {
        email_ids: [EMAIL_1],
        to_folder_id: FOLDER_TO,
        create_rule: { field: "domain", value: "ACME.com" },
      },
    });
    expect(fake.calls.inserts).toHaveLength(0);
    expect(performMove).toHaveBeenCalledWith(
      TEST_USER,
      EMAIL_1,
      FOLDER_TO,
      "Domain rule: acme.com → Receipts",
    );
    expect(res).toEqual({ moved: 1, failed: 0 });
  });

  it("inserts a new lowercased rule and retags moved rows as domain_rule", async () => {
    seedTargetFolder();
    const res = await bulkMoveEmails({
      data: {
        email_ids: [EMAIL_1, EMAIL_2],
        to_folder_id: FOLDER_TO,
        create_rule: { field: "domain", value: "Acme.COM" },
      },
    });
    expect(res).toEqual({ moved: 2, failed: 0 });

    const filterInserts = fake.calls.inserts.filter((i) => i.table === "folder_filters");
    expect(filterInserts).toHaveLength(1);
    expect(filterInserts[0]!.payload).toEqual({
      folder_id: FOLDER_TO,
      field: "domain",
      op: "contains",
      value: "acme.com",
    });

    // Audit retag: only rows that actually landed in the destination folder.
    const retags = fake.calls.updates.filter((u) => u.table === "emails");
    expect(retags).toHaveLength(1);
    expect(retags[0]!.payload).toEqual({ classified_by: "domain_rule" });
    expect(retags[0]!.filters).toEqual([
      { op: "eq", col: "user_id", value: TEST_USER },
      { op: "in", col: "id", value: [EMAIL_1, EMAIL_2] },
      { op: "eq", col: "folder_id", value: FOLDER_TO },
    ]);
  });

  it("tallies per-email failures and skips the retag without a rule", async () => {
    performMove.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({
      ok: false,
      error: "Email not found",
    });
    const res = await bulkMoveEmails({
      data: { email_ids: [EMAIL_1, EMAIL_2], to_folder_id: FOLDER_TO },
    });
    expect(res).toEqual({ moved: 1, failed: 1 });
    // No create_rule → no folder lookup, no filter insert, no retag update.
    expect(fake.calls.inserts).toHaveLength(0);
    expect(fake.calls.updates).toHaveLength(0);
    // Reason argument stays undefined so performMove uses its default wording.
    expect(performMove).toHaveBeenCalledWith(TEST_USER, EMAIL_1, FOLDER_TO, undefined);
  });
});

describe("moveEmailToInbox", () => {
  function seedFiledEmail(overrides: Record<string, unknown> = {}) {
    fake.seed("emails", [
      {
        id: EMAIL_1,
        user_id: TEST_USER,
        folder_id: FOLDER_OLD,
        gmail_message_id: "gm-1",
        gmail_account_id: "acc-1",
        from_addr: "Sender@Foo.com",
        raw_labels: ["L-OLD", "KEEP"],
        ...overrides,
      },
    ]);
    fake.seed("folders", [
      { id: FOLDER_OLD, user_id: TEST_USER, name: "Newsletters", gmail_label_id: "L-OLD" },
    ]);
  }

  it("recomputes raw_labels (drop folder label, add INBOX) and mirrors it to Gmail", async () => {
    seedFiledEmail();
    const res = await moveEmailToInbox({ data: { email_id: EMAIL_1 } });

    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: EMAIL_1,
      classification_reason: "Moved to Inbox manually",
    });

    const emailUpdates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(emailUpdates).toHaveLength(1);
    expect(emailUpdates[0]!.payload).toEqual({
      folder_id: null,
      is_archived: false,
      classified_by: "manual_inbox",
      ai_confidence: 1,
      matched_filter_ids: [],
      raw_labels: ["KEEP", "INBOX"],
    });

    expect(modifyMessage).toHaveBeenCalledWith("acc-1", "gm-1", ["INBOX"], ["L-OLD"]);

    // Stop training the AI on the mistaken filing.
    const exampleDeletes = fake.calls.deletes.filter((d) => d.table === "folder_examples");
    expect(exampleDeletes).toHaveLength(1);
    expect(exampleDeletes[0]!.filters).toEqual([
      { op: "eq", col: "folder_id", value: FOLDER_OLD },
      { op: "eq", col: "gmail_message_id", value: "gm-1" },
    ]);

    expect(res).toEqual({
      ok: true,
      from_addr: "Sender@Foo.com",
      domain: "foo.com",
      override_added: null,
    });
  });

  it("inserts a new override globally (no account scope) and busts the context cache", async () => {
    seedFiledEmail();
    const res = await moveEmailToInbox({
      data: { email_id: EMAIL_1, add_override: "domain" },
    });

    const overrideInserts = fake.calls.inserts.filter((i) => i.table === "inbox_overrides");
    expect(overrideInserts).toHaveLength(1);
    expect(overrideInserts[0]!.payload).toEqual({
      user_id: TEST_USER,
      gmail_account_id: null,
      match_type: "domain",
      value: "foo.com",
    });
    expect(invalidateAccountContextForUser).toHaveBeenCalledWith(TEST_USER);
    expect(res).toMatchObject({ override_added: "domain" });
  });

  it("promotes a legacy account-scoped override to global instead of duplicating it", async () => {
    seedFiledEmail();
    fake.seed("inbox_overrides", [
      {
        id: "ov-1",
        user_id: TEST_USER,
        gmail_account_id: "acc-1",
        match_type: "email",
        value: "sender@foo.com",
      },
    ]);
    const res = await moveEmailToInbox({
      data: { email_id: EMAIL_1, add_override: "email" },
    });

    expect(fake.calls.inserts.filter((i) => i.table === "inbox_overrides")).toHaveLength(0);
    const promotions = fake.calls.updates.filter((u) => u.table === "inbox_overrides");
    expect(promotions).toHaveLength(1);
    expect(promotions[0]!.payload).toEqual({ gmail_account_id: null });
    expect(promotions[0]!.filters).toEqual([{ op: "eq", col: "id", value: "ov-1" }]);
    expect(invalidateAccountContextForUser).toHaveBeenCalledWith(TEST_USER);
    expect(res).toMatchObject({ override_added: "email" });
  });
});

describe("addInboxOverride", () => {
  it("normalizes the value (trim, lowercase, strip leading @) and upserts globally", async () => {
    const res = await addInboxOverride({
      data: { value: "  @Foo.COM ", match_type: "domain" },
    });

    const upserts = fake.calls.upserts.filter((u) => u.table === "inbox_overrides");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.payload).toEqual({
      user_id: TEST_USER,
      gmail_account_id: null,
      match_type: "domain",
      value: "foo.com",
    });
    // Race safety net: duplicate-key errors are swallowed by ignoreDuplicates.
    expect(upserts[0]!.options).toEqual({
      onConflict: "user_id,match_type,value",
      ignoreDuplicates: true,
    });
    expect(invalidateAccountContextForUser).toHaveBeenCalledWith(TEST_USER);
    expect(res).toEqual({
      ok: true,
      value: "foo.com",
      match_type: "domain",
      already: false,
      reprocessed_count: 0,
    });
  });

  it("is idempotent: an existing global override writes nothing and reports already=true", async () => {
    fake.seed("inbox_overrides", [
      {
        id: "ov-1",
        user_id: TEST_USER,
        gmail_account_id: null,
        match_type: "domain",
        value: "foo.com",
      },
    ]);
    const res = await addInboxOverride({
      data: { value: "foo.com", match_type: "domain" },
    });
    expect(fake.calls.upserts).toHaveLength(0);
    expect(fake.calls.updates).toHaveLength(0);
    expect(invalidateAccountContextForUser).not.toHaveBeenCalled();
    expect(res).toMatchObject({ already: true, reprocessed_count: 0 });
  });
});

describe("addInboxOverride({ reprocess_past: true })", () => {
  const EMAIL_3 = "77777777-7777-4777-8777-777777777777";
  const EMAIL_4 = "88888888-8888-4888-8888-888888888888";
  const EMAIL_5 = "99999999-9999-4999-8999-999999999999";

  function emailRow(id: string, over: Record<string, unknown> = {}) {
    return {
      id,
      user_id: TEST_USER,
      gmail_account_id: ACC,
      gmail_message_id: `gm-${id.slice(0, 2)}`,
      folder_id: FOLDER_OLD,
      from_addr: "news@acme.com",
      raw_labels: ["L-OLD"],
      ...over,
    };
  }

  function seedReprocessFixture() {
    fake.seed("folders", [
      { id: FOLDER_OLD, user_id: TEST_USER, name: "Newsletters", gmail_label_id: "L-OLD" },
    ]);
    fake.seed("emails", [
      emailRow(EMAIL_1),
      emailRow(EMAIL_2, { from_addr: "Jane <jane@acme.com> (Sales)" }),
      // Lookalike domain: passes the `%@acme.com%` ilike prefilter but loses
      // the exact emailDomain() recheck.
      emailRow(EMAIL_3, { from_addr: "evil@acme.com.evil.com" }),
      // Already in the inbox → excluded by `.not("folder_id", "is", null)`.
      emailRow(EMAIL_4, { folder_id: null }),
      // Another tenant's mail.
      emailRow(EMAIL_5, { user_id: "someone-else" }),
    ]);
  }

  it("restores only the rows whose exact sender domain matches, and reports the tally", async () => {
    seedReprocessFixture();

    const res = await addInboxOverride({
      data: { value: "acme.com", match_type: "domain", reprocess_past: true },
    });

    expect(res).toMatchObject({ ok: true, already: false, reprocessed_count: 2 });
    const restores = fake.calls.updates.filter((u) => u.table === "emails");
    expect(restores.map((u) => u.filters)).toStrictEqual([
      [{ op: "eq", col: "id", value: EMAIL_1, extra: undefined }],
      [{ op: "eq", col: "id", value: EMAIL_2, extra: undefined }],
    ]);
    expect(restores[0]?.payload).toStrictEqual({
      folder_id: null,
      is_archived: false,
      classified_by: "inbox_override",
      matched_filter_ids: [],
      // The folder label is dropped and INBOX added, so the inbox view
      // (raw_labels @> ['INBOX']) actually shows the message again.
      raw_labels: ["INBOX"],
    });
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: EMAIL_1,
      classification_reason: 'Always-inbox: domain "acme.com"',
      ai_summary: "",
    });
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-11", ["INBOX"], ["L-OLD"]);
    expect(modifyMessage).toHaveBeenCalledTimes(2);
  });

  it("prefilters an email override on the exact address", async () => {
    seedReprocessFixture();

    const res = await addInboxOverride({
      data: { value: "News@Acme.com", match_type: "email", reprocess_past: true },
    });

    // Only EMAIL_1 stores exactly "news@acme.com"; EMAIL_2's row is a display
    // name, so the equality recheck drops it.
    expect(res).toMatchObject({ reprocessed_count: 1 });
    const read = fake.calls.selects.find((s) => s.table === "emails");
    expect(read?.filters).toStrictEqual([
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
      { op: "not", col: "folder_id", value: null, extra: "is" },
      { op: "ilike", col: "from_addr", value: "news@acme.com", extra: undefined },
    ]);
  });

  it("logs a failing row and keeps going instead of aborting the sweep", async () => {
    seedReprocessFixture();
    fake.onUpdate("emails", (_payload, filters) => {
      if (filters.some((f) => f.value === EMAIL_1)) throw new Error("deadlock detected");
    });

    const res = await addInboxOverride({
      data: { value: "acme.com", match_type: "domain", reprocess_past: true },
    });

    expect(res).toMatchObject({ reprocessed_count: 1 });
    expect(logError).toHaveBeenCalledWith(
      "gmail.reprocess.row_failed",
      { email_id: EMAIL_1 },
      expect.any(Error),
    );
  });

  it("runs the restores through a pool of at most five workers", async () => {
    fake.seed("folders", [
      { id: FOLDER_OLD, user_id: TEST_USER, name: "Newsletters", gmail_label_id: "L-OLD" },
    ]);
    const ids = Array.from({ length: 7 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}`);
    fake.seed(
      "emails",
      ids.map((id, i) => emailRow(id, { gmail_message_id: `gm-${i}` })),
    );

    let inFlight = 0;
    let peak = 0;
    // Resolves after every worker that can start has reached modifyMessage:
    // everything before it in restoreEmailToInbox settles on the microtask
    // queue, which drains before a zero-delay timer.
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 0));
    modifyMessage.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight--;
      return {};
    });

    const res = await addInboxOverride({
      data: { value: "acme.com", match_type: "domain", reprocess_past: true },
    });

    expect(res).toMatchObject({ reprocessed_count: 7 });
    expect(peak).toBe(5);
    expect(modifyMessage).toHaveBeenCalledTimes(7);
  });

  it("skips the folder-label lookup entirely when nothing matches", async () => {
    fake.seed("emails", []);

    const res = await addInboxOverride({
      data: { value: "acme.com", match_type: "domain", reprocess_past: true },
    });

    expect(res).toMatchObject({ reprocessed_count: 0 });
    expect(fake.calls.selects.some((s) => s.table === "folders")).toBe(false);
    expect(modifyMessage).not.toHaveBeenCalled();
  });
});

describe("reanalyzeEmail (folder-write path 6)", () => {
  const FOLDER_NEW = FOLDER_TO;

  function seedFolders() {
    fake.seed("folders", [
      { id: FOLDER_OLD, user_id: TEST_USER, name: "Vendors", gmail_label_id: "L-OLD" },
      { id: FOLDER_NEW, user_id: TEST_USER, name: "Receipts", gmail_label_id: "L-NEW" },
    ]);
  }

  it("rejects an email owned by another user before classifying or writing", async () => {
    getEmailsDecrypted.mockResolvedValue({
      rows: [decryptedEmail({ user_id: "someone-else" })],
      error: null,
    });

    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(reanalyzeEmail, "intruder")({ data: { email_id: EMAIL_1 } }),
      rejects: "Email not found",
    });
    expect(classifyParsedEmail).not.toHaveBeenCalled();
  });

  it("refuses a row missing the Gmail identifiers rather than classifying a stub", async () => {
    getEmailsDecrypted.mockResolvedValue({
      rows: [decryptedEmail({ gmail_message_id: "" })],
      error: null,
    });

    await expect(reanalyzeEmail({ data: { email_id: EMAIL_1 } })).rejects.toThrow(
      "Email is missing required identifiers",
    );
    expect(writeCount(fake)).toBe(0);
  });

  // ── Exit 1: an always-inbox override now wins ──────────────────────────
  it("restores an inbox_override match to the inbox, dropping the folder label", async () => {
    seedFolders();
    getEmailsDecrypted.mockResolvedValue({
      rows: [decryptedEmail({ raw_labels: ["L-OLD", "IMPORTANT"] })],
      error: null,
    });
    classifyParsedEmail.mockResolvedValue(
      classification({
        folder_id: null,
        classified_by: "inbox_override",
        classification_reason: "Always-inbox: domain acme.com",
        ai_summary: "already summarized",
      }),
    );

    const res = await reanalyzeEmail({ data: { email_id: EMAIL_1 } });

    expect(res).toStrictEqual({
      ok: true,
      folder_id: null,
      folder_name: null,
      classified_by: "inbox_override",
      classification_reason: "Always-inbox: domain acme.com",
      changed: true,
    });
    const updates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload).toStrictEqual({
      folder_id: null,
      is_archived: false,
      classified_by: "inbox_override",
      ai_confidence: 1,
      matched_filter_ids: [],
      raw_labels: ["IMPORTANT", "INBOX"],
    });
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-1", ["INBOX"], ["L-OLD"]);
    // The classifier already produced a summary, so the fallback stays idle.
    expect(summarizeEmail).not.toHaveBeenCalled();
  });

  // ── Exit 2: the current folder's own rules now veto this sender ────────
  it("evicts an email its folder's domain allowlist now rejects, naming the folder", async () => {
    seedFolders();
    getEmailsDecrypted.mockResolvedValue({ rows: [decryptedEmail()], error: null });
    loadAccountContext.mockResolvedValue(
      accountContext([
        // Real allowlist rule: only partner.com may live in Vendors.
        {
          id: "ff-1",
          folder_id: FOLDER_OLD,
          field: "domain",
          op: "domain_in",
          value: "partner.com",
        },
      ]),
    );
    classifyParsedEmail.mockResolvedValue(
      classification({ folder_id: null, classified_by: "ai_no_match", ai_summary: "s" }),
    );

    const res = await reanalyzeEmail({ data: { email_id: EMAIL_1 } });

    expect(res).toStrictEqual({
      ok: true,
      folder_id: null,
      folder_name: null,
      classified_by: "excluded",
      classification_reason: 'Removed from "Vendors" — sender excluded by folder rule',
      changed: true,
    });
    const updates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(updates[0]?.payload).toMatchObject({
      folder_id: null,
      classified_by: "excluded",
      raw_labels: ["INBOX"],
    });
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-1", ["INBOX"], ["L-OLD"]);
  });

  it("does not evict on a veto when the classifier itself errored", async () => {
    seedFolders();
    getEmailsDecrypted.mockResolvedValue({ rows: [decryptedEmail()], error: null });
    loadAccountContext.mockResolvedValue(
      accountContext([
        {
          id: "ff-1",
          folder_id: FOLDER_OLD,
          field: "domain",
          op: "domain_in",
          value: "partner.com",
        },
      ]),
    );
    classifyParsedEmail.mockResolvedValue(
      classification({ folder_id: null, classified_by: "ai_error", ai_summary: "s" }),
    );

    const res = await reanalyzeEmail({ data: { email_id: EMAIL_1 } });

    expect(res).toMatchObject({ classified_by: "kept", folder_id: FOLDER_OLD, changed: false });
    expect(fake.calls.updates.filter((u) => u.table === "emails")).toHaveLength(0);
  });

  // ── Exit 3: the classifier abstained; keep the current assignment ──────
  it("keeps the current folder when the classifier picks nothing and no rule vetoes", async () => {
    seedFolders();
    getEmailsDecrypted.mockResolvedValue({ rows: [decryptedEmail()], error: null });
    classifyParsedEmail.mockResolvedValue(
      classification({ folder_id: null, classified_by: "ai", classification_reason: "" }),
    );
    summarizeEmail.mockResolvedValue("a fresh summary");

    const res = await reanalyzeEmail({ data: { email_id: EMAIL_1 } });

    expect(res).toStrictEqual({
      ok: true,
      folder_id: FOLDER_OLD,
      folder_name: null,
      classified_by: "kept",
      classification_reason: "Classifier found no better folder — kept current assignment",
      changed: false,
    });
    // Only the summary is persisted: the folder assignment is untouched.
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: EMAIL_1,
      ai_summary: "a fresh summary",
    });
    expect(fake.calls.updates.filter((u) => u.table === "emails")).toHaveLength(0);
    expect(modifyMessage).not.toHaveBeenCalled();
  });

  // ── Exit 4: surfaced — filed, but kept visible in the inbox ────────────
  it("files a surfaced email and gives it both the folder label and INBOX", async () => {
    seedFolders();
    getEmailsDecrypted.mockResolvedValue({ rows: [decryptedEmail()], error: null });
    classifyParsedEmail.mockResolvedValue(
      classification({
        folder_id: FOLDER_NEW,
        classified_by: "surfaced_to_inbox",
        classification_reason: "Surfaced: from a known contact",
        ai_confidence: 0.8,
        ai_summary: "s",
        matched_filter_ids: ["ff-9"],
      }),
    );

    const res = await reanalyzeEmail({ data: { email_id: EMAIL_1 } });

    expect(res).toStrictEqual({
      ok: true,
      folder_id: FOLDER_NEW,
      folder_name: null,
      classified_by: "surfaced_to_inbox",
      classification_reason: "Surfaced: from a known contact",
      changed: true,
    });
    const updates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload).toStrictEqual({
      folder_id: FOLDER_NEW,
      classified_by: "surfaced_to_inbox",
      ai_confidence: 0.8,
      matched_filter_ids: ["ff-9"],
      surfaced_to_inbox: true,
      is_archived: false,
      snoozed_until: null,
    });
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-1", ["INBOX", "L-NEW"], []);
  });

  it("still reports a surfaced email as filed when the Gmail label write fails", async () => {
    seedFolders();
    getEmailsDecrypted.mockResolvedValue({ rows: [decryptedEmail()], error: null });
    classifyParsedEmail.mockResolvedValue(
      classification({
        folder_id: FOLDER_NEW,
        classified_by: "surfaced_to_inbox",
        ai_summary: "s",
      }),
    );
    modifyMessage.mockRejectedValue(new Error("Gmail 429"));

    const res = await reanalyzeEmail({ data: { email_id: EMAIL_1 } });

    expect(res).toMatchObject({ ok: true, changed: true });
    expect(logError).toHaveBeenCalledWith(
      "gmail.reanalyze.surface_label_failed",
      { email_id: EMAIL_1 },
      expect.any(Error),
    );
  });

  // ── Exit 5: refiled into a different folder ────────────────────────────
  // CHARACTERIZATION(reanalyze-overrides-gmail-label-filing): reanalyze
  // re-derives with skipGmailLabelMatch, so a message the user filed BY
  // APPLYING A GMAIL LABEL is silently refiled by rules — flip when fixed.
  it("passes skipGmailLabelMatch, so a message filed by a Gmail label is refiled by rules", async () => {
    seedFolders();
    getEmailsDecrypted.mockResolvedValue({
      rows: [decryptedEmail({ raw_labels: ["L-OLD"] })],
      error: null,
    });
    classifyParsedEmail.mockResolvedValue(
      classification({
        folder_id: FOLDER_NEW,
        classified_by: "domain_rule",
        classification_reason: "Domain rule: acme.com",
        ai_confidence: 1,
        ai_summary: "sum",
        matched_filter_ids: ["ff-1"],
      }),
    );

    const res = await reanalyzeEmail({ data: { email_id: EMAIL_1 } });

    expect(classifyParsedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ raw_labels: ["L-OLD"] }),
      TEST_USER,
      ACC,
      expect.objectContaining({ skipGmailLabelMatch: true }),
    );
    const updates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload).toStrictEqual({
      folder_id: FOLDER_NEW,
      classified_by: "domain_rule",
      ai_confidence: 1,
      matched_filter_ids: ["ff-1"],
      surfaced_to_inbox: false,
    });
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-1", ["L-NEW"], ["L-OLD"]);
    expect(res).toStrictEqual({
      ok: true,
      folder_id: FOLDER_NEW,
      folder_name: "Receipts",
      classified_by: "domain_rule",
      classification_reason: "Domain rule: acme.com",
      changed: true,
    });
  });

  it("files an unfiled email without asking Gmail to remove a label it never had", async () => {
    seedFolders();
    getEmailsDecrypted.mockResolvedValue({
      rows: [decryptedEmail({ folder_id: null, raw_labels: ["INBOX"] })],
      error: null,
    });
    classifyParsedEmail.mockResolvedValue(
      classification({ folder_id: FOLDER_NEW, classified_by: "filter", ai_summary: "s" }),
    );

    const res = await reanalyzeEmail({ data: { email_id: EMAIL_1 } });

    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-1", ["L-NEW"], []);
    expect(res).toMatchObject({ folder_id: FOLDER_NEW, folder_name: "Receipts", changed: true });
  });

  // ── Exit 6: same folder as before ─────────────────────────────────────
  it("reports changed=false and touches no Gmail label when the folder is unchanged", async () => {
    seedFolders();
    getEmailsDecrypted.mockResolvedValue({ rows: [decryptedEmail()], error: null });
    classifyParsedEmail.mockResolvedValue(
      classification({
        folder_id: FOLDER_OLD,
        classified_by: "filter",
        classification_reason: "Filter: acme.com",
        ai_summary: "s",
      }),
    );

    const res = await reanalyzeEmail({ data: { email_id: EMAIL_1 } });

    expect(res).toStrictEqual({
      ok: true,
      folder_id: FOLDER_OLD,
      folder_name: null,
      classified_by: "filter",
      classification_reason: "Filter: acme.com",
      changed: false,
    });
    expect(modifyMessage).not.toHaveBeenCalled();
    // The row is still rewritten, so a changed confidence/rule set lands.
    expect(fake.calls.updates.filter((u) => u.table === "emails")).toHaveLength(1);
  });

  // ── The summariser fallback, shared by every exit ──────────────────────
  it("summarizes from the email body when the classifier returned no summary", async () => {
    seedFolders();
    getEmailsDecrypted.mockResolvedValue({ rows: [decryptedEmail()], error: null });
    classifyParsedEmail.mockResolvedValue(
      classification({ folder_id: FOLDER_NEW, classified_by: "filter", ai_summary: "" }),
    );
    summarizeEmail.mockResolvedValue("A weekly digest from Acme.");

    await reanalyzeEmail({ data: { email_id: EMAIL_1 } });

    expect(summarizeEmail).toHaveBeenCalledWith({
      from_name: "Acme News",
      from_addr: "news@acme.com",
      subject: "Weekly digest",
      body_text: "body",
      snippet: "snip",
    });
    expect(updateEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({ ai_summary: "A weekly digest from Acme." }),
    );
  });

  it("files the email anyway when the summariser throws", async () => {
    seedFolders();
    getEmailsDecrypted.mockResolvedValue({ rows: [decryptedEmail()], error: null });
    classifyParsedEmail.mockResolvedValue(
      classification({ folder_id: FOLDER_NEW, classified_by: "filter", ai_summary: "" }),
    );
    summarizeEmail.mockRejectedValue(new Error("AI budget exhausted"));

    const res = await reanalyzeEmail({ data: { email_id: EMAIL_1 } });

    expect(logError).toHaveBeenCalledWith(
      "gmail.reanalyze.summarize_failed",
      { email_id: EMAIL_1 },
      expect.any(Error),
    );
    expect(updateEmailEncrypted).toHaveBeenCalledWith(expect.objectContaining({ ai_summary: "" }));
    expect(res).toMatchObject({ ok: true, folder_id: FOLDER_NEW, changed: true });
  });
});
