// Unit tests for the move-related server functions (src/lib/gmail/move.functions.ts).
// This file also establishes the harness for testing `createServerFn` modules:
// @tanstack/react-start is mocked with the __fixtures__/server-fn-stub so each
// exported server function becomes a directly-callable async function whose
// zod inputValidator still runs, with `context.userId = TEST_USER`.
//
// The destructive move core (performMove) is covered by move-email.server.test.ts;
// here we pin the wrapper contracts: ownership checks before any mutation,
// rule creation dedupe/normalization, tally + retag semantics, inbox label
// recomputation, and the global inbox-override promotion rules.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";

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

// -- DB: shared chainable fake. Property accesses are deferred into method
// bodies so the hoisted factory never touches `fake` before its initializer.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
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
  classifyParsedEmail: vi.fn(),
  loadAccountContext: vi.fn(),
}));

vi.mock("../ai.server", () => ({
  suggestReply: vi.fn(),
  suggestRuleUpdates: vi.fn(),
  suggestFolderFromEmails: vi.fn(),
  generateAiRuleFromPurpose: vi.fn(),
  generateAiRuleFromLabelSamples: vi.fn(),
  summarizeEmail: vi.fn(),
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

vi.mock("../log.server", () => ({
  logError: () => {},
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

vi.mock("../sync/encrypted-reader", () => ({
  getEmailsDecrypted: vi.fn(async () => ({ rows: [], error: null })),
}));

import {
  moveEmailToFolder,
  bulkMoveEmails,
  moveEmailToInbox,
  addInboxOverride,
} from "./move.functions";

const EMAIL_1 = "11111111-1111-4111-8111-111111111111";
const EMAIL_2 = "22222222-2222-4222-8222-222222222222";
const FOLDER_TO = "33333333-3333-4333-8333-333333333333";
const FOLDER_OLD = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  fake.reset();
  performMove.mockClear();
  performMove.mockResolvedValue({ ok: true });
  modifyMessage.mockClear();
  modifyMessage.mockResolvedValue({});
  updateEmailEncrypted.mockClear();
  invalidateAccountContextForUser.mockClear();
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

  it("runs the zod inputValidator (non-uuid ids never reach the handler)", async () => {
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
    expect(filterInserts[0].payload).toEqual({
      folder_id: FOLDER_TO,
      field: "domain",
      op: "contains",
      value: "acme.com",
    });

    // Audit retag: only rows that actually landed in the destination folder.
    const retags = fake.calls.updates.filter((u) => u.table === "emails");
    expect(retags).toHaveLength(1);
    expect(retags[0].payload).toEqual({ classified_by: "domain_rule" });
    expect(retags[0].filters).toEqual([
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
    expect(emailUpdates[0].payload).toEqual({
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
    expect(exampleDeletes[0].filters).toEqual([
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
    expect(overrideInserts[0].payload).toEqual({
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
    expect(promotions[0].payload).toEqual({ gmail_account_id: null });
    expect(promotions[0].filters).toEqual([{ op: "eq", col: "id", value: "ov-1" }]);
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
    expect(upserts[0].payload).toEqual({
      user_id: TEST_USER,
      gmail_account_id: null,
      match_type: "domain",
      value: "foo.com",
    });
    // Race safety net: duplicate-key errors are swallowed by ignoreDuplicates.
    expect(upserts[0].options).toEqual({
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
