// Unit tests for the folder-writing server functions in rules.functions.ts —
// audit path 7 in docs/rules-engine-audit.md §1 ("Rule actions / 'apply rule
// now' — direct folder + label writes"). None of these paths write through
// the single writer (persistDecision), so each contract is pinned as-is:
//
//   - reclassifyEmails is the DECISION-DERIVED path: it re-runs
//     classifyParsedEmail (skipGmailLabelMatch) and must mirror the decision
//     exactly — folder_id written when the decision differs, cleared via the
//     shared restoreEmailToInbox helper when the decision says none, and a
//     transient ai_error never yanks a correctly-filed email;
//   - applyFilterRuleToPast selects candidates with the SAME predicate
//     module as the live preview (applySimpleRulePredicate — see
//     rule-query.test.ts for that invariant) and routes every row through
//     performMove, the manual-move writer — which is why this bulk path
//     cannot drift from the manual-move write shape;
//   - createFolderAndAssign and applyFolderBehaviorRetroactive assemble
//     their own patches (characterized below, bugs flagged inline);
//   - ownership scoping: every path is scoped to context.userId / an owned
//     folder / an owned account; an impersonated caller touches nothing.
//
// SUSPECTED BUGS pinned as-is (fix belongs to audit Phase B, not here):
//   [BUG-1] reclassifyEmails' set-branch (:630) updates folder_id in the DB
//           but never swaps Gmail labels (only the surfaced special-case
//           touches Gmail) — unlike reanalyzeEmail, which mirrors the move
//           to Gmail. DB and Gmail label state drift apart.
//   [BUG-2] createFolderAndAssign (:790) assigns the selected emails with a
//           hand-rolled patch (folder_id/classified_by/ai_confidence) instead
//           of performMove: the old folder's Gmail label is never removed and
//           matched_filter_ids is left stale. (The cross-tenant / cross-account
//           id gap it used to have is FIXED: ids are scoped to the caller's
//           rows on the target account before any write.)
//
// Harness: __fixtures__/server-fn-stub makes each createServerFn export a
// plain callable with context.userId = TEST_USER (overridable per call for
// impersonation checks); __fixtures__/supabase-fake backs supabaseAdmin.
// gmail-helpers.server (getOwnedAccount / restoreEmailToInbox) is REAL so
// the inbox-restore write shape is characterized, not assumed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";

const fake = makeSupabaseFake();

// The shared fake echoes an insert's payload back from .select().single(),
// but createFolderAndAssign needs the DB-generated folder id. When set, the
// folders-table insert records normally AND resolves this id.
let nextFolderInsertId: string | null = null;

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
    from: (table: string) => {
      const b = fake.supabaseAdmin.from(table);
      if (table !== "folders" || nextFolderInsertId === null) return b;
      return {
        ...b,
        insert: (payload: unknown) => {
          const wb = b.insert(payload);
          return {
            ...wb,
            select: () => ({
              async single() {
                await wb.select().single(); // still record the insert
                return { data: { id: nextFolderInsertId }, error: null };
              },
            }),
          };
        },
      };
    },
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

// -- Gmail API surface ------------------------------------------------------
type ListPage = { messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string };
/** The parseMessage fields scanGmailForFolder actually reads. */
type ParsedMessage = {
  gmail_message_id: string;
  thread_id: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_addrs: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  received_at: string | null;
  is_read: boolean;
  has_attachment: boolean;
  raw_labels: string[] | null;
};
function parsed(over: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    gmail_message_id: "m-1",
    thread_id: "t-1",
    from_addr: "a@acme.com",
    from_name: "A",
    to_addrs: "me@x.com",
    subject: "s",
    snippet: "",
    body_text: "b",
    body_html: "",
    received_at: "2026-01-01T00:00:00Z",
    is_read: false,
    has_attachment: false,
    raw_labels: ["INBOX"],
    ...over,
  };
}

const modifyMessage = vi.fn(async (..._args: unknown[]) => ({}));
const batchModifyMessages = vi.fn(async (..._args: unknown[]) => ({}));
const listMessages = vi.fn(
  async (_accountId: string, _opts: Record<string, unknown>): Promise<ListPage> => ({
    messages: [],
  }),
);
const getMessage = vi.fn(async (_accountId: string, id: string): Promise<{ id: string }> => ({
  id,
}));
const parseMessage = vi.fn((raw: unknown): ParsedMessage =>
  parsed({ gmail_message_id: (raw as { id: string }).id }),
);
vi.mock("../gmail.server", () => ({
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  modifyMessage: (...args: unknown[]) => modifyMessage(...args),
  batchModifyMessages: (...args: unknown[]) => batchModifyMessages(...args),
  trashMessage: vi.fn(),
  sendMessage: vi.fn(),
  ensureWatch: vi.fn(),
  stopWatch: vi.fn(),
  listMessages: (accountId: string, opts: Record<string, unknown>) => listMessages(accountId, opts),
  getMessage: (accountId: string, id: string) => getMessage(accountId, id),
  getMessageMetadata: vi.fn(),
  getMessageLabels: vi.fn(),
  getThread: vi.fn(),
  parseMessage: (raw: unknown) => parseMessage(raw),
}));

const classifyParsedEmail = vi.fn(
  async (
    _parsed: unknown,
    _userId: string,
    _accountId: string,
    _opts: unknown,
  ): Promise<Record<string, unknown>> => ({ folder_id: null, classified_by: "none" }),
);
const invalidateAccountContext = vi.fn((_accountId: string) => undefined);
const runMessageJobs = vi.fn(async (..._args: unknown[]): Promise<Record<string, number>> => ({
  processed: 0,
  ok: 0,
  failed: 0,
  dlq: 0,
  retryable: 0,
}));
const retryMessageJob = vi.fn(async (_jobId: string) => undefined);
vi.mock("../sync.server", () => ({
  backfillRecent: vi.fn(),
  backfillWindow: vi.fn(),
  syncSinceHistory: vi.fn(),
  learnFromLinkedLabel: vi.fn(),
  reconcileLocalInbox: vi.fn(),
  loadOlderFromLabel: vi.fn(),
  runMessageJobs: (...args: unknown[]) => runMessageJobs(...args),
  retryMessageJob: (jobId: string) => retryMessageJob(jobId),
  enqueueMessageJob: vi.fn(),
  startBackfillJob: vi.fn(),
  cancelBackfillJob: vi.fn(),
  invalidateAccountContext: (accountId: string) => invalidateAccountContext(accountId),
  invalidateAccountContextForUser: vi.fn(),
  bulkCatchupClaim: vi.fn(),
  syncReadState: vi.fn(),
  classifyParsedEmail: (parsed: unknown, userId: string, accountId: string, opts: unknown) =>
    classifyParsedEmail(parsed, userId, accountId, opts),
  loadAccountContext: vi.fn(),
}));

// performMove is the shared manual-move writer; applyFilterRuleToPast MUST
// route every row through it (the agreement contract), so it is mocked as a
// seam and asserted on — its own write shape has its own suite.
const performMove = vi.fn(
  async (
    _userId: string,
    _emailId: string,
    _toFolderId: string,
    _reason?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true }),
);
vi.mock("../move-email.server", () => ({
  performMove: (userId: string, emailId: string, toFolderId: string, reason?: string) =>
    performMove(userId, emailId, toFolderId, reason),
}));

const suggestFolderFromEmails = vi.fn(
  async (_emails: unknown[]): Promise<Record<string, unknown>> => ({ name: "Suggested" }),
);
vi.mock("../ai.server", () => ({
  suggestFolderFromEmails: (emails: unknown[]) => suggestFolderFromEmails(emails),
}));

vi.mock("../log.server", () => ({
  logError: () => {},
  logInfo: () => {},
  logAudit: () => {},
}));

const upsertEmailEncrypted = vi.fn(async (_input: unknown) => ({
  id: "db-x" as string | null,
  error: null as string | null,
}));
const updateEmailEncrypted = vi.fn(async (_input: unknown) => ({ error: null as string | null }));
vi.mock("../sync/encrypted-writer", () => ({
  upsertEmailEncrypted: (input: unknown) => upsertEmailEncrypted(input),
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
  addFolderRule,
  applyFilterRuleToPast,
  applyFolderBehaviorRetroactive,
  countMatchingForRule,
  createFolderAndAssign,
  reclassifyEmails,
  retryJob,
  runJobsNow,
  scanGmailForFolder,
  suggestFolderFromSelection,
} from "./rules.functions";

const ACC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMAIL_1 = "11111111-1111-4111-8111-111111111111";
const EMAIL_2 = "22222222-2222-4222-8222-222222222222";
const EMAIL_3 = "33333333-3333-4333-8333-333333333333";
const FOLDER_A = "55555555-5555-4555-8555-555555555555";
const FOLDER_B = "66666666-6666-4666-8666-666666666666";
const NEW_FOLDER = "99999999-9999-4999-8999-999999999999";

function emailRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: TEST_USER,
    gmail_account_id: ACC,
    gmail_message_id: `gm-${id.slice(0, 2)}`,
    folder_id: null,
    from_addr: "a@acme.com",
    is_archived: false,
    is_read: false,
    raw_labels: ["INBOX"],
    received_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

/** A decrypted row as getEmailsDecrypted hands it to reclassifyEmails. */
function decryptedRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: TEST_USER,
    gmail_account_id: ACC,
    gmail_message_id: `gm-${id.slice(0, 2)}`,
    folder_id: null,
    from_addr: "a@acme.com",
    from_name: "A",
    to_addrs: "me@x.com",
    subject: "s",
    snippet: "",
    body_text: "b",
    body_html: "",
    has_attachment: false,
    received_at: "2026-01-01T00:00:00Z",
    raw_labels: ["INBOX"],
    ...over,
  };
}

const emailUpdates = () => fake.calls.updates.filter((u) => u.table === "emails");

beforeEach(() => {
  fake.reset();
  nextFolderInsertId = null;
  for (const fn of [
    modifyMessage,
    batchModifyMessages,
    listMessages,
    getMessage,
    parseMessage,
    classifyParsedEmail,
    invalidateAccountContext,
    runMessageJobs,
    retryMessageJob,
    performMove,
    suggestFolderFromEmails,
    upsertEmailEncrypted,
    updateEmailEncrypted,
    getEmailsDecrypted,
  ])
    fn.mockClear();
  modifyMessage.mockResolvedValue({});
  batchModifyMessages.mockResolvedValue({});
  listMessages.mockResolvedValue({ messages: [] });
  getMessage.mockImplementation(async (_accountId: string, id: string) => ({ id }));
  parseMessage.mockImplementation((raw: unknown) =>
    parsed({ gmail_message_id: (raw as { id: string }).id }),
  );
  classifyParsedEmail.mockResolvedValue({ folder_id: null, classified_by: "none" });
  runMessageJobs.mockResolvedValue({ processed: 0, ok: 0, failed: 0, dlq: 0, retryable: 0 });
  performMove.mockResolvedValue({ ok: true });
  suggestFolderFromEmails.mockResolvedValue({ name: "Suggested" });
  upsertEmailEncrypted.mockResolvedValue({ id: "db-x", error: null });
  updateEmailEncrypted.mockResolvedValue({ error: null });
  getEmailsDecrypted.mockResolvedValue({ rows: [], error: null });
});

describe("addFolderRule (audit path 7 — rule creation)", () => {
  it("normalizes the value, defaults the op, inserts the rule, and invalidates the account context", async () => {
    fake.seed("folders", [
      { id: FOLDER_A, user_id: TEST_USER, name: "Vendors", gmail_account_id: ACC },
    ]);

    const res = await addFolderRule({
      data: { folder_id: FOLDER_A, field: "domain", value: " @Acme.COM " },
    });
    expect(res).toEqual({ ok: true, already: false, folder_name: "Vendors" });

    // Value normalized via the SHARED normalizeRuleValue (rule-query.ts) —
    // lowercased, leading @ stripped — so the stored rule matches what
    // countMatchingForRule / applyFilterRuleToPast will later select.
    const inserts = fake.calls.inserts.filter((i) => i.table === "folder_filters");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload).toEqual({
      folder_id: FOLDER_A,
      field: "domain",
      op: "contains", // default for non-subject fields
      value: "acme.com",
    });
    expect(invalidateAccountContext).toHaveBeenCalledWith(ACC);
  });

  it("dedupes against an identical existing rule: no insert, no invalidation, already: true", async () => {
    fake.seed("folders", [
      { id: FOLDER_A, user_id: TEST_USER, name: "Vendors", gmail_account_id: ACC },
    ]);
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_A, field: "domain", op: "contains", value: "acme.com" },
    ]);

    const res = await addFolderRule({
      data: { folder_id: FOLDER_A, field: "domain", value: "@ACME.com", op: "contains" },
    });
    expect(res).toEqual({ ok: true, already: true, folder_name: "Vendors" });
    expect(fake.calls.inserts).toHaveLength(0);
    expect(invalidateAccountContext).not.toHaveBeenCalled();
  });

  it("denies a cross-user caller before writing anything", async () => {
    fake.seed("folders", [
      { id: FOLDER_A, user_id: TEST_USER, name: "Vendors", gmail_account_id: ACC },
    ]);
    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(
          addFolderRule,
          "intruder",
        )({
          data: { folder_id: FOLDER_A, field: "domain", value: "acme.com" },
        }),
      rejects: "Folder not found",
    });
  });
});

describe("applyFilterRuleToPast (audit path 7 — bulk move of past mail)", () => {
  it("selects candidates with the shared predicate, scoped to the caller and skipping rows already in the target, and routes each row through performMove", async () => {
    fake.seed("folders", [{ id: FOLDER_B, user_id: TEST_USER, name: "Vendors" }]);
    fake.seed("emails", [
      emailRow(EMAIL_1, { folder_id: FOLDER_A }),
      // Already in the target folder → excluded by the .neq guard.
      emailRow(EMAIL_2, { folder_id: FOLDER_B }),
      // Another user's row → excluded by the user_id scope.
      emailRow(EMAIL_3, { user_id: "someone-else" }),
    ]);

    const res = await applyFilterRuleToPast({
      data: {
        account_id: ACC,
        to_folder_id: FOLDER_B,
        field: "domain",
        op: "contains",
        value: "@Acme.COM",
      },
    });
    expect(res).toEqual({ moved: 1, failed: 0, archived: 0 });

    // The candidate select uses applySimpleRulePredicate — the SAME module
    // the live count preview uses (rule-query.test.ts pins the predicate
    // shapes) — plus caller scoping and the already-in-target skip.
    const sel = fake.calls.selects.find((s) => s.table === "emails")!;
    expect(sel.filters).toContainEqual({ op: "eq", col: "user_id", value: TEST_USER });
    expect(sel.filters).toContainEqual({ op: "eq", col: "gmail_account_id", value: ACC });
    expect(sel.filters).toContainEqual({ op: "neq", col: "folder_id", value: FOLDER_B });
    expect(sel.filters).toContainEqual({ op: "ilike", col: "from_addr", value: "%@acme.com%" });

    // Every candidate is routed through performMove — the manual-move
    // writer — so this bulk path CANNOT drift from the manual-move write
    // shape (label swap, encrypted reason, ownership re-check).
    expect(performMove).toHaveBeenCalledTimes(1);
    expect(performMove).toHaveBeenCalledWith(
      TEST_USER,
      EMAIL_1,
      FOLDER_B,
      "Domain rule: acme.com → Vendors",
    );

    // Post-move bookkeeping: classified_by is stamped over performMove's
    // "manual_move", guarded to rows that actually landed in the target.
    const updates = emailUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toEqual({ classified_by: "domain_rule" });
    expect(updates[0]!.filters).toEqual([
      { op: "eq", col: "user_id", value: TEST_USER },
      { op: "in", col: "id", value: [EMAIL_1] },
      { op: "eq", col: "folder_id", value: FOLDER_B },
    ]);
  });

  it("a failed performMove is counted and excluded from the bookkeeping update", async () => {
    fake.seed("folders", [{ id: FOLDER_B, user_id: TEST_USER, name: "Vendors" }]);
    fake.seed("emails", [
      emailRow(EMAIL_1, { received_at: "2026-01-02T00:00:00Z" }), // newest first
      emailRow(EMAIL_2, { received_at: "2026-01-01T00:00:00Z" }),
    ]);
    performMove
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "gmail down" });

    const res = await applyFilterRuleToPast({
      data: {
        account_id: ACC,
        to_folder_id: FOLDER_B,
        field: "from",
        op: "contains",
        value: "a@acme.com",
      },
    });
    expect(res).toEqual({ moved: 1, failed: 1, archived: 0 });

    const updates = emailUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toEqual({ classified_by: "filter" });
    expect(updates[0]!.filters).toContainEqual({ op: "in", col: "id", value: [EMAIL_1] });
  });

  it("archive pass: matching inbox rows are archived in Gmail + DB, including rows already in the target folder", async () => {
    fake.seed("folders", [{ id: FOLDER_B, user_id: TEST_USER, name: "Vendors" }]);
    fake.seed("emails", [
      emailRow(EMAIL_1, {
        folder_id: FOLDER_A,
        gmail_message_id: "gm-1",
        raw_labels: ["INBOX", "L-A"],
        received_at: "2026-01-02T00:00:00Z",
      }),
      // Already in the target folder: not moved, but STILL archived.
      emailRow(EMAIL_2, {
        folder_id: FOLDER_B,
        gmail_message_id: "gm-2",
        raw_labels: ["INBOX"],
        received_at: "2026-01-01T00:00:00Z",
      }),
    ]);

    const res = await applyFilterRuleToPast({
      data: {
        account_id: ACC,
        to_folder_id: FOLDER_B,
        field: "from",
        op: "contains",
        value: "a@acme.com",
        archive: true,
      },
    });
    expect(res).toEqual({ moved: 1, failed: 0, archived: 2 });

    // Archive select re-applies the same predicate, scoped to unarchived rows.
    const archSel = fake.calls.selects.filter((s) => s.table === "emails")[1]!;
    expect(archSel.filters).toContainEqual({ op: "eq", col: "is_archived", value: false });

    // Gmail INBOX label removed in one batch; DB rows patched individually.
    expect(batchModifyMessages).toHaveBeenCalledWith(ACC, ["gm-1", "gm-2"], [], ["INBOX"]);
    const archives = emailUpdates().filter((u) => "is_archived" in (u.payload as object));
    expect(archives).toHaveLength(2);
    expect(archives[0]!.payload).toEqual({ is_archived: true, raw_labels: ["L-A"] });
    expect(archives[0]!.filters).toEqual([{ op: "eq", col: "id", value: EMAIL_1 }]);
    expect(archives[1]!.payload).toEqual({ is_archived: true, raw_labels: [] });
  });

  it("denies a cross-user caller before selecting or moving anything", async () => {
    fake.seed("folders", [{ id: FOLDER_B, user_id: TEST_USER, name: "Vendors" }]);
    fake.seed("emails", [emailRow(EMAIL_1)]);
    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(
          applyFilterRuleToPast,
          "intruder",
        )({
          data: {
            account_id: ACC,
            to_folder_id: FOLDER_B,
            field: "domain",
            op: "contains",
            value: "acme.com",
          },
        }),
      rejects: "Folder not found",
    });
    expect(performMove).not.toHaveBeenCalled();
  });
});

describe("reclassifyEmails (audit path 7 — decision-derived rewrite)", () => {
  it("mirrors the classifier decision exactly: writes the decided folder when it differs, leaves an agreeing row untouched", async () => {
    getEmailsDecrypted.mockResolvedValue({
      rows: [
        decryptedRow(EMAIL_1, { folder_id: FOLDER_A }), // decision differs → rewrite
        decryptedRow(EMAIL_2, { folder_id: FOLDER_B }), // decision agrees → unchanged
      ],
      error: null,
    });
    classifyParsedEmail.mockResolvedValue({
      folder_id: FOLDER_B,
      classified_by: "domain_rule",
      classification_reason: "Domain rule: acme.com",
      ai_confidence: 1,
      matched_filter_ids: ["ff-1"],
    });

    const res = await reclassifyEmails({ data: { email_ids: [EMAIL_1, EMAIL_2] } });
    expect(res).toEqual({ routed: 1, unchanged: 1, failed: 0 });

    // The decision comes from classifyParsedEmail — the canonical ladder —
    // with skipGmailLabelMatch (same knob the audit flags on reanalyze).
    expect(classifyParsedEmail).toHaveBeenCalledTimes(2);
    expect(classifyParsedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ from_addr: "a@acme.com", subject: "s", raw_labels: ["INBOX"] }),
      TEST_USER,
      ACC,
      { skipGmailLabelMatch: true },
    );

    // The write mirrors the decision field-for-field.
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: EMAIL_1,
      classification_reason: "Domain rule: acme.com",
    });
    const updates = emailUpdates();
    expect(updates).toHaveLength(1); // agreeing row: zero writes
    expect(updates[0]!.payload).toEqual({
      folder_id: FOLDER_B,
      classified_by: "domain_rule",
      ai_confidence: 1,
      matched_filter_ids: ["ff-1"],
      surfaced_to_inbox: false,
    });
    expect(updates[0]!.filters).toEqual([{ op: "eq", col: "id", value: EMAIL_1 }]);

    // CHARACTERIZATION(reclassify-skips-gmail-labels): the DB now says folder B, but Gmail is never
    // told — no label swap happens on this branch (reanalyzeEmail DOES swap
    // labels for the same decision). DB and Gmail drift until the next sync
    // path happens to touch the message.
    expect(modifyMessage).not.toHaveBeenCalled();
  });

  it("clears a stale folder through restoreEmailToInbox when the decision says none", async () => {
    getEmailsDecrypted.mockResolvedValue({
      rows: [decryptedRow(EMAIL_1, { folder_id: FOLDER_A, raw_labels: ["L-A"] })],
      error: null,
    });
    fake.seed("folders", [{ id: FOLDER_A, user_id: TEST_USER, gmail_label_id: "L-A" }]);
    classifyParsedEmail.mockResolvedValue({
      folder_id: null,
      classified_by: "inbox_override",
      classification_reason: "Always-inbox override: a@acme.com",
      ai_confidence: 1,
    });

    const res = await reclassifyEmails({ data: { email_ids: [EMAIL_1] } });
    expect(res).toEqual({ routed: 1, unchanged: 0, failed: 0 });

    // The clear runs through the SHARED restoreEmailToInbox helper (real
    // here): folder_id → null, old folder label dropped, INBOX re-added,
    // and the swap mirrored to Gmail.
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: EMAIL_1,
      classification_reason: "Always-inbox override: a@acme.com",
    });
    const updates = emailUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toEqual({
      folder_id: null,
      is_archived: false,
      classified_by: "inbox_override",
      ai_confidence: 1,
      matched_filter_ids: [],
      raw_labels: ["INBOX"],
    });
    expect(updates[0]!.filters).toEqual([{ op: "eq", col: "id", value: EMAIL_1 }]);
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-11", ["INBOX"], ["L-A"]);
  });

  it("a transient ai_error never clears a correctly-filed email", async () => {
    getEmailsDecrypted.mockResolvedValue({
      rows: [decryptedRow(EMAIL_1, { folder_id: FOLDER_A })],
      error: null,
    });
    classifyParsedEmail.mockResolvedValue({ folder_id: null, classified_by: "ai_error" });

    const res = await reclassifyEmails({ data: { email_ids: [EMAIL_1] } });
    expect(res).toEqual({ routed: 0, unchanged: 1, failed: 0 });
    expect(emailUpdates()).toHaveLength(0);
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
    expect(modifyMessage).not.toHaveBeenCalled();
  });

  it("a surfaced decision rewrites even when the folder is unchanged, keeping the email visible in the inbox", async () => {
    getEmailsDecrypted.mockResolvedValue({
      rows: [decryptedRow(EMAIL_1, { folder_id: FOLDER_B })],
      error: null,
    });
    fake.seed("folders", [{ id: FOLDER_B, user_id: TEST_USER, gmail_label_id: "L-B" }]);
    classifyParsedEmail.mockResolvedValue({
      folder_id: FOLDER_B, // SAME folder — surfacing forces the write anyway
      classified_by: "surfaced_to_inbox",
      classification_reason: "Surface rule matched",
      ai_confidence: 0.9,
      matched_filter_ids: [],
    });

    const res = await reclassifyEmails({ data: { email_ids: [EMAIL_1] } });
    expect(res).toEqual({ routed: 1, unchanged: 0, failed: 0 });

    const updates = emailUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toEqual({
      folder_id: FOLDER_B,
      classified_by: "surfaced_to_inbox",
      ai_confidence: 0.9,
      matched_filter_ids: [],
      surfaced_to_inbox: true,
      is_archived: false,
      snoozed_until: null,
    });
    // Surfaced mail carries BOTH its folder label and INBOX in Gmail.
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-11", ["INBOX", "L-B"], []);
  });

  it("an impersonated caller touches nothing: every row fails the ownership check before classification", async () => {
    // expectDeniedCrossUser doesn't fit here — reclassifyEmails reports a
    // failed count instead of rejecting — so its contract (deny AND zero
    // writes) is asserted manually.
    getEmailsDecrypted.mockResolvedValue({
      rows: [decryptedRow(EMAIL_1, { folder_id: FOLDER_A })],
      error: null,
    });
    const res = await impersonate(
      reclassifyEmails,
      "intruder",
    )({
      data: { email_ids: [EMAIL_1] },
    });
    expect(res).toEqual({ routed: 0, unchanged: 0, failed: 1 });
    expect(classifyParsedEmail).not.toHaveBeenCalled();
    expect(fake.calls.updates).toHaveLength(0);
    expect(fake.calls.inserts).toHaveLength(0);
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
  });
});

describe("createFolderAndAssign (audit path 7 — assembles its own patch)", () => {
  it("creates the folder (+ optional rule), assigns the selected emails with a direct patch, and invalidates the account context", async () => {
    fake.seed("gmail_accounts", [{ id: ACC, user_id: TEST_USER }]);
    fake.seed("emails", [
      { id: EMAIL_1, user_id: TEST_USER, gmail_account_id: ACC },
      { id: EMAIL_2, user_id: TEST_USER, gmail_account_id: ACC },
    ]);
    nextFolderInsertId = NEW_FOLDER;

    const res = await createFolderAndAssign({
      data: {
        account_id: ACC,
        name: "Vendors",
        color: "#ff0000",
        ai_rule: "vendor mail",
        filter: { field: "domain", op: "contains", value: "acme.com" },
        email_ids: [EMAIL_1, EMAIL_2],
      },
    });
    expect(res).toEqual({ folder_id: NEW_FOLDER });

    const folderInsert = fake.calls.inserts.find((i) => i.table === "folders")!;
    expect(folderInsert.payload).toEqual({
      user_id: TEST_USER,
      gmail_account_id: ACC,
      name: "Vendors",
      color: "#ff0000",
      ai_rule: "vendor mail",
    });
    const filterInsert = fake.calls.inserts.find((i) => i.table === "folder_filters")!;
    expect(filterInsert.payload).toEqual({
      folder_id: NEW_FOLDER,
      field: "domain",
      op: "contains",
      value: "acme.com",
    });

    expect(updateEmailEncrypted).toHaveBeenCalledTimes(2);
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: EMAIL_1,
      classification_reason: 'Moved into new folder "Vendors"',
    });

    // CHARACTERIZATION(create-folder-assign-hand-rolled-patch): the assignment is a hand-rolled patch, NOT
    // performMove — Gmail labels are untouched (the old folder's label
    // stays on the message) and matched_filter_ids is left stale.
    const updates = emailUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toEqual({
      folder_id: NEW_FOLDER,
      classified_by: "manual_move",
      ai_confidence: 1,
    });
    expect(updates[0]!.filters).toEqual([
      { op: "eq", col: "user_id", value: TEST_USER },
      { op: "in", col: "id", value: [EMAIL_1, EMAIL_2] },
    ]);
    expect(performMove).not.toHaveBeenCalled();
    expect(modifyMessage).not.toHaveBeenCalled();

    expect(invalidateAccountContext).toHaveBeenCalledWith(ACC);
  });

  it("never writes to email ids the caller does not own or that belong to another account", async () => {
    // Regression: the encrypted writer is a SECURITY DEFINER RPC keyed by
    // id alone, and this handler used to call it for every client-supplied
    // id before checking ownership — a cross-tenant write.
    const VICTIM_EMAIL = "33333333-3333-4333-8333-333333333333";
    const OTHER_ACC_EMAIL = "44444444-4444-4444-8444-444444444444";
    const OTHER_ACC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    fake.seed("gmail_accounts", [{ id: ACC, user_id: TEST_USER }]);
    fake.seed("emails", [
      { id: EMAIL_1, user_id: TEST_USER, gmail_account_id: ACC },
      { id: VICTIM_EMAIL, user_id: "victim", gmail_account_id: ACC },
      { id: OTHER_ACC_EMAIL, user_id: TEST_USER, gmail_account_id: OTHER_ACC },
    ]);
    nextFolderInsertId = NEW_FOLDER;

    await createFolderAndAssign({
      data: {
        account_id: ACC,
        name: "Vendors",
        color: "#ff0000",
        ai_rule: "",
        email_ids: [EMAIL_1, VICTIM_EMAIL, OTHER_ACC_EMAIL],
      },
    });

    expect(updateEmailEncrypted).toHaveBeenCalledTimes(1);
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: EMAIL_1,
      classification_reason: 'Moved into new folder "Vendors"',
    });
    const updates = emailUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.filters).toEqual([
      { op: "eq", col: "user_id", value: TEST_USER },
      { op: "in", col: "id", value: [EMAIL_1] },
    ]);
  });

  it("skips the email writes entirely when none of the ids are the caller's", async () => {
    fake.seed("gmail_accounts", [{ id: ACC, user_id: TEST_USER }]);
    fake.seed("emails", [{ id: EMAIL_1, user_id: "victim", gmail_account_id: ACC }]);
    nextFolderInsertId = NEW_FOLDER;
    const res = await createFolderAndAssign({
      data: { account_id: ACC, name: "V", color: "#ff0000", ai_rule: "", email_ids: [EMAIL_1] },
    });
    expect(res).toEqual({ folder_id: NEW_FOLDER });
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
    expect(emailUpdates()).toHaveLength(0);
  });

  it("denies a caller who does not own the account before creating anything", async () => {
    fake.seed("gmail_accounts", [{ id: ACC, user_id: TEST_USER }]);
    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(
          createFolderAndAssign,
          "intruder",
        )({
          data: {
            account_id: ACC,
            name: "Vendors",
            color: "#ff0000",
            ai_rule: "",
            email_ids: [EMAIL_1],
          },
        }),
      rejects: "Not authorized for this account",
    });
    expect(invalidateAccountContext).not.toHaveBeenCalled();
  });
});

describe("applyFolderBehaviorRetroactive (characterization — behavior flags only, never folder_id)", () => {
  // This path re-applies a folder's behavior toggle to rows ALREADY
  // classified into it (folder_id eq + user_id eq). It writes is_read /
  // is_archived / raw_labels but never derives or touches folder_id, so it
  // is a folder-scoped side-effect writer, not a filing decider.
  it("archive: rows still unarchived get the Gmail INBOX removal and a per-row is_archived/raw_labels patch", async () => {
    fake.seed("folders", [{ id: FOLDER_A, user_id: TEST_USER, gmail_account_id: ACC }]);
    fake.seed("emails", [
      emailRow(EMAIL_1, {
        folder_id: FOLDER_A,
        gmail_message_id: "gm-1",
        raw_labels: ["INBOX", "L-A"],
      }),
      // Already archived → not selected, not touched again.
      emailRow(EMAIL_2, { folder_id: FOLDER_A, is_archived: true }),
      // Another user's row in the same folder id → excluded by user scope.
      emailRow(EMAIL_3, { folder_id: FOLDER_A, user_id: "someone-else" }),
    ]);

    const res = await applyFolderBehaviorRetroactive({
      data: { folderId: FOLDER_A, behavior: "archive" },
    });
    expect(res).toEqual({ count: 1 });

    expect(batchModifyMessages).toHaveBeenCalledWith(ACC, ["gm-1"], [], ["INBOX"]);
    const updates = emailUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toEqual({ is_archived: true, raw_labels: ["L-A"] });
    expect(updates[0]!.filters).toEqual([{ op: "eq", col: "id", value: EMAIL_1 }]);
  });

  it("mark_read bulk-updates unread rows; star touches Gmail only and writes no DB patch", async () => {
    fake.seed("folders", [{ id: FOLDER_A, user_id: TEST_USER, gmail_account_id: ACC }]);
    fake.seed("emails", [
      emailRow(EMAIL_1, { folder_id: FOLDER_A, gmail_message_id: "gm-1", is_read: false }),
      emailRow(EMAIL_2, { folder_id: FOLDER_A, gmail_message_id: "gm-2", is_read: true }),
    ]);

    const readRes = await applyFolderBehaviorRetroactive({
      data: { folderId: FOLDER_A, behavior: "mark_read" },
    });
    expect(readRes).toEqual({ count: 1 }); // only the unread row
    expect(batchModifyMessages).toHaveBeenCalledWith(ACC, ["gm-1"], [], ["UNREAD"]);
    const readUpdates = emailUpdates();
    expect(readUpdates).toHaveLength(1);
    expect(readUpdates[0]!.payload).toEqual({ is_read: true });
    expect(readUpdates[0]!.filters).toEqual([{ op: "in", col: "id", value: [EMAIL_1] }]);

    batchModifyMessages.mockClear();
    const starRes = await applyFolderBehaviorRetroactive({
      data: { folderId: FOLDER_A, behavior: "star" },
    });
    // No DB column tracks starred: every row is touched in Gmail, none in DB.
    expect(starRes).toEqual({ count: 2 });
    expect(batchModifyMessages).toHaveBeenCalledWith(ACC, ["gm-1", "gm-2"], ["STARRED"], []);
    expect(emailUpdates()).toHaveLength(1); // still just the mark_read update
  });

  it("denies a caller who does not own the folder", async () => {
    fake.seed("folders", [{ id: FOLDER_A, user_id: TEST_USER, gmail_account_id: ACC }]);
    fake.seed("emails", [emailRow(EMAIL_1, { folder_id: FOLDER_A })]);
    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(
          applyFolderBehaviorRetroactive,
          "intruder",
        )({
          data: { folderId: FOLDER_A, behavior: "archive" },
        }),
      rejects: "Not authorized",
    });
    expect(batchModifyMessages).not.toHaveBeenCalled();
  });
});

describe("countMatchingForRule (live preview count)", () => {
  it("counts only the caller's rows on the named account, using the shared rule predicate", async () => {
    fake.seed("emails", [
      emailRow(EMAIL_1),
      emailRow(EMAIL_2, { from_addr: "b@other.test" }),
      emailRow(EMAIL_3, { user_id: "someone-else" }),
    ]);

    const res = await countMatchingForRule({
      data: { account_id: ACC, field: "domain", op: "contains", value: " @Acme.COM " },
    });
    expect(res).toEqual({ count: 1 });

    // Same normalization and same predicate module as addFolderRule /
    // applyFilterRuleToPast, so the number shown in the drawer is the number
    // of emails the rule will actually claim.
    const sel = fake.calls.selects.find((s) => s.table === "emails")!;
    expect(sel.filters).toContainEqual({ op: "eq", col: "user_id", value: TEST_USER });
    expect(sel.filters).toContainEqual({ op: "eq", col: "gmail_account_id", value: ACC });
    expect(sel.filters).toContainEqual({ op: "ilike", col: "from_addr", value: "%@acme.com%" });
  });

  it("short-circuits a whitespace-only value to zero without querying the DB", async () => {
    const res = await countMatchingForRule({
      data: { account_id: ACC, field: "from", op: "contains", value: "   " },
    });
    expect(res).toEqual({ count: 0 });
    expect(fake.calls.selects).toHaveLength(0);
  });

  it("surfaces a failed count as an error rather than reporting zero matches", async () => {
    fake.onSelect("emails", () => ({ message: "statement timeout" }));
    await expect(
      countMatchingForRule({
        data: { account_id: ACC, field: "from", op: "contains", value: "a@acme.com" },
      }),
    ).rejects.toThrow("statement timeout");
  });
});

describe("retryJob / runJobsNow (queue controls)", () => {
  it("re-queues a job the caller owns through the shared retry writer", async () => {
    fake.seed("message_jobs", [{ id: EMAIL_1, user_id: TEST_USER }]);
    const res = await retryJob({ data: { id: EMAIL_1 } });
    expect(res).toEqual({ ok: true });
    expect(retryMessageJob).toHaveBeenCalledWith(EMAIL_1);
  });

  it("refuses to re-queue another user's job", async () => {
    fake.seed("message_jobs", [{ id: EMAIL_1, user_id: "victim" }]);
    await expectDeniedCrossUser({
      fake,
      call: () => retryJob({ data: { id: EMAIL_1 } }),
      rejects: "Not found",
    });
    expect(retryMessageJob).not.toHaveBeenCalled();
  });

  it("reports Not found for a job id that does not exist", async () => {
    await expect(retryJob({ data: { id: EMAIL_1 } })).rejects.toThrow("Not found");
    expect(retryMessageJob).not.toHaveBeenCalled();
  });

  // CHARACTERIZATION(run-jobs-now-drains-global-queue): runJobsNow hands a
  // client-chosen limit straight to the cross-tenant worker — nothing scopes
  // the drain to the caller — flip when fixed.
  it("drains the shared queue with the caller's limit and no tenant scope at all", async () => {
    runMessageJobs.mockResolvedValue({ processed: 3, ok: 2, failed: 1, dlq: 0, retryable: 1 });
    const res = await runJobsNow({ data: { limit: 100 } });
    expect(res).toEqual({ processed: 3, ok: 2, failed: 1, dlq: 0, retryable: 1 });
    // The ONLY argument is the limit: the worker claims by priority across
    // every tenant, so this drains (and reports counts for) other users' jobs.
    expect(runMessageJobs).toHaveBeenCalledWith(100);
  });

  it("defaults the drain size to 25 when the caller names no limit", async () => {
    await runJobsNow({ data: {} });
    expect(runMessageJobs).toHaveBeenCalledWith(25);
  });
});

describe("suggestFolderFromSelection (AI folder proposal from a selection)", () => {
  it("sends only the caller's rows to the AI and returns its suggestion verbatim", async () => {
    fake.seed("emails", [
      emailRow(EMAIL_1, { from_addr: "billing@acme.com" }),
      emailRow(EMAIL_2, { from_addr: "intruder@evil.test", user_id: "someone-else" }),
    ]);
    suggestFolderFromEmails.mockResolvedValue({ name: "Billing", color: "#f59e0b" });

    const res = await suggestFolderFromSelection({ data: { email_ids: [EMAIL_1, EMAIL_2] } });
    expect(res).toEqual({ name: "Billing", color: "#f59e0b" });
    expect(suggestFolderFromEmails).toHaveBeenCalledWith([
      { from_addr: "billing@acme.com", from_name: null, subject: null, snippet: null },
    ]);
  });

  it("throws without calling the AI when none of the ids belong to the caller", async () => {
    fake.seed("emails", [emailRow(EMAIL_1, { user_id: "victim" })]);
    await expect(suggestFolderFromSelection({ data: { email_ids: [EMAIL_1] } })).rejects.toThrow(
      "No emails found",
    );
    expect(suggestFolderFromEmails).not.toHaveBeenCalled();
  });
});

// scanGmailForFolder is audit path 6/7's Gmail-side ingest: it translates a
// folder's own rules into Gmail queries, pulls the matching mail into the
// local corpus, and files each message with the SHARED ingest classifier
// (gmail/ingest-classify.ts, real here) rather than a private precedence.
// What is pinned below is the boundary the classifier does not own: which
// Gmail queries get run, which messages are fetched at all, and the exact
// decision write that lands on an ingested row.
describe("scanGmailForFolder (audit path 6/7 — scan Gmail for a folder's rules)", () => {
  /** Seed the folder under scan plus the account-wide rule context the
   * handler reloads (`folders` "*" + every folder_filters row). */
  function seedScanFolder(over: Record<string, unknown> = {}) {
    fake.seed("folders", [
      {
        id: FOLDER_A,
        user_id: TEST_USER,
        gmail_account_id: ACC,
        name: "Vendors",
        filter_tree: null,
        ...over,
      },
    ]);
  }

  it("a folder whose only rules are untranslatable runs no Gmail query at all", async () => {
    // A regex leaf has no Gmail search equivalent. The flat rule below is
    // translatable but MUST be ignored: filter_tree is authoritative.
    seedScanFolder({
      filter_tree: {
        type: "group",
        op: "and",
        children: [{ type: "cond", field: "body", op: "regex", value: "inv[0-9]+" }],
      },
    });
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_A, field: "from", op: "contains", value: "acme" },
    ]);

    const res = await scanGmailForFolder({ data: { folder_id: FOLDER_A } });
    expect(res).toEqual({
      ok: false,
      ingested: 0,
      found: 0,
      queries_run: 0,
      skipped_regex: 1,
      truncated: false,
      reason: "no_translatable_rules",
    });
    expect(listMessages).not.toHaveBeenCalled();
    expect(upsertEmailEncrypted).not.toHaveBeenCalled();
  });

  it("pages a query 5×100 and stops at the page cap even when Gmail offers more", async () => {
    seedScanFolder();
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_A, field: "from", op: "contains", value: "acme" },
    ]);
    let page = 0;
    listMessages.mockImplementation(async () => {
      page++;
      return {
        messages: [
          { id: `m-${page}a`, threadId: "t" },
          { id: `m-${page}b`, threadId: "t" },
        ],
        // Always offers another page: only MAX_PAGES stops the loop.
        nextPageToken: `p${page}`,
      };
    });

    const res = await scanGmailForFolder({ data: { folder_id: FOLDER_A, months: 12 } });
    expect(res).toEqual({
      ok: true,
      ingested: 10,
      found: 10,
      queries_run: 1,
      skipped_regex: 0,
      truncated: false,
    });

    expect(listMessages).toHaveBeenCalledTimes(5);
    // The rule is translated once and the window comes from `months`.
    expect(listMessages).toHaveBeenNthCalledWith(1, ACC, {
      q: "from:acme newer_than:12m",
      maxResults: 100,
      pageToken: undefined,
    });
    // Each page carries the previous page's token forward.
    expect(listMessages).toHaveBeenNthCalledWith(5, ACC, {
      q: "from:acme newer_than:12m",
      maxResults: 100,
      pageToken: "p4",
    });
  });

  it("defaults the scan window to six months", async () => {
    seedScanFolder();
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_A, field: "domain", op: "contains", value: "acme.com" },
    ]);
    await scanGmailForFolder({ data: { folder_id: FOLDER_A } });
    expect(listMessages).toHaveBeenCalledWith(ACC, {
      q: "from:acme.com newer_than:6m",
      maxResults: 100,
      pageToken: undefined,
    });
  });

  it("stops at the hard ingest cap mid-run and reports the result as truncated", async () => {
    seedScanFolder();
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_A, field: "from", op: "contains", value: "acme" },
      { id: "ff-2", folder_id: FOLDER_A, field: "from", op: "contains", value: "beta" },
      { id: "ff-3", folder_id: FOLDER_A, field: "from", op: "contains", value: "gamma" },
    ]);
    // Every query yields a full 5×100 page run of distinct ids: 1500 messages
    // are reachable, the cap is 1000.
    listMessages.mockImplementation(async (_accountId, opts) => {
      const q = String(opts.q);
      const page = opts.pageToken ? Number(opts.pageToken) : 0;
      return {
        messages: Array.from({ length: 100 }, (_, i) => ({
          id: `${q}#${page}#${i}`,
          threadId: "t",
        })),
        nextPageToken: String(page + 1),
      };
    });

    const res = await scanGmailForFolder({ data: { folder_id: FOLDER_A } });
    expect(res).toEqual({
      ok: true,
      ingested: 1000,
      found: 1000,
      queries_run: 2, // the third query is never issued
      skipped_regex: 0,
      truncated: true,
    });
    expect(upsertEmailEncrypted).toHaveBeenCalledTimes(1000);
  });

  it("skips message ids already stored for this user, but not ones stored for someone else", async () => {
    seedScanFolder();
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_A, field: "from", op: "contains", value: "acme" },
    ]);
    fake.seed("emails", [
      emailRow(EMAIL_1, { gmail_message_id: "m-1" }),
      // Another tenant's copy of m-2 must not make this user's scan skip it.
      emailRow(EMAIL_2, { gmail_message_id: "m-2", user_id: "someone-else" }),
    ]);
    listMessages.mockResolvedValue({
      messages: [
        { id: "m-1", threadId: "t" },
        { id: "m-2", threadId: "t" },
        { id: "m-3", threadId: "t" },
      ],
    });

    const res = await scanGmailForFolder({ data: { folder_id: FOLDER_A } });
    expect(res).toEqual({
      ok: true,
      ingested: 2,
      found: 3,
      queries_run: 1,
      skipped_regex: 0,
      truncated: false,
    });
    // The known message is never even fetched — the skip happens before getMessage.
    expect(getMessage.mock.calls.map((c) => c[1]).sort()).toEqual(["m-2", "m-3"]);
  });

  it("writes the ingest decision with full confidence and the rule ids that produced it", async () => {
    seedScanFolder();
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_A, field: "from", op: "contains", value: "acme" },
    ]);
    listMessages.mockResolvedValue({ messages: [{ id: "m-1", threadId: "t" }] });

    const res = await scanGmailForFolder({ data: { folder_id: FOLDER_A } });
    expect(res).toEqual({
      ok: true,
      ingested: 1,
      found: 1,
      queries_run: 1,
      skipped_regex: 0,
      truncated: false,
    });

    // The row lands first with the decision's classified_by…
    expect(upsertEmailEncrypted).toHaveBeenCalledTimes(1);
    expect(upsertEmailEncrypted.mock.calls[0]![0]).toMatchObject({
      user_id: TEST_USER,
      gmail_account_id: ACC,
      gmail_message_id: "m-1",
      classified_by: "filter",
      is_archived: false,
    });
    // …then the folder decision itself, stamped as a deterministic rule
    // match: confidence 1 and the exact folder_filters ids that fired.
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: "db-x",
      folder_id: FOLDER_A,
      ai_confidence: 1,
      classification_reason: "Folder rule: from acme",
      matched_filter_ids: ["ff-1"],
    });
  });

  it("a failed insert is neither counted as ingested nor followed by a decision write", async () => {
    seedScanFolder();
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_A, field: "from", op: "contains", value: "acme" },
    ]);
    listMessages.mockResolvedValue({ messages: [{ id: "m-1", threadId: "t" }] });
    upsertEmailEncrypted.mockResolvedValue({ id: null, error: "duplicate key" });

    const res = await scanGmailForFolder({ data: { folder_id: FOLDER_A } });
    expect(res).toMatchObject({ ok: true, ingested: 0, found: 1 });
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
  });

  it("a paused folder's Gmail label does not claim scanned mail", async () => {
    fake.seed("folders", [
      {
        id: FOLDER_A,
        user_id: TEST_USER,
        gmail_account_id: ACC,
        name: "Vendors",
        filter_tree: null,
      },
      {
        id: FOLDER_B,
        user_id: TEST_USER,
        gmail_account_id: ACC,
        name: "Paused",
        gmail_label_id: "L-P",
        processing_enabled: false,
        filter_tree: null,
      },
    ]);
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_A, field: "from", op: "contains", value: "acme" },
    ]);
    listMessages.mockResolvedValue({ messages: [{ id: "m-1", threadId: "t" }] });
    // Carries the paused folder's label and matches no rule.
    parseMessage.mockReturnValue(
      parsed({ gmail_message_id: "m-1", from_addr: "z@nomatch.test", raw_labels: ["L-P"] }),
    );

    const res = await scanGmailForFolder({ data: { folder_id: FOLDER_A } });
    expect(res).toMatchObject({ ok: true, ingested: 1 });
    expect(upsertEmailEncrypted.mock.calls[0]![0]).toMatchObject({
      classified_by: "gmail_search_ingest",
    });
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
  });

  it("an active folder's Gmail label still claims scanned mail ahead of any rule", async () => {
    fake.seed("folders", [
      {
        id: FOLDER_A,
        user_id: TEST_USER,
        gmail_account_id: ACC,
        name: "Vendors",
        filter_tree: null,
      },
      {
        id: FOLDER_B,
        user_id: TEST_USER,
        gmail_account_id: ACC,
        name: "Filed",
        gmail_label_id: "L-B",
        processing_enabled: true,
        filter_tree: null,
      },
    ]);
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_A, field: "from", op: "contains", value: "acme" },
    ]);
    listMessages.mockResolvedValue({ messages: [{ id: "m-1", threadId: "t" }] });
    // Matches the SCANNED folder's rule, but the user already filed it under
    // another folder's label — the label wins.
    parseMessage.mockReturnValue(
      parsed({ gmail_message_id: "m-1", from_addr: "a@acme.com", raw_labels: ["L-B"] }),
    );

    await scanGmailForFolder({ data: { folder_id: FOLDER_A } });
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: "db-x",
      folder_id: FOLDER_B,
      ai_confidence: 1,
      classification_reason: "Matched Gmail label",
      matched_filter_ids: [],
    });
  });

  it("a revoked Gmail grant with nothing ingested asks for re-auth and abandons the remaining queries", async () => {
    seedScanFolder();
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_A, field: "from", op: "contains", value: "acme" },
      { id: "ff-2", folder_id: FOLDER_A, field: "from", op: "contains", value: "beta" },
    ]);
    listMessages.mockRejectedValue(new Error("invalid_grant: token has been expired or revoked"));

    const res = await scanGmailForFolder({ data: { folder_id: FOLDER_A } });
    expect(res).toEqual({
      ok: false,
      ingested: 0,
      found: 0,
      queries_run: 1, // broke out instead of burning the second query
      skipped_regex: 0,
      truncated: false,
      reason: "reauth_required",
    });
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  it("one failing query does not abandon the scan", async () => {
    seedScanFolder();
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_A, field: "from", op: "contains", value: "acme" },
      { id: "ff-2", folder_id: FOLDER_A, field: "from", op: "contains", value: "beta" },
    ]);
    listMessages
      .mockRejectedValueOnce(new Error("rate limit exceeded"))
      .mockResolvedValueOnce({ messages: [{ id: "m-1", threadId: "t" }] });

    const res = await scanGmailForFolder({ data: { folder_id: FOLDER_A } });
    expect(res).toMatchObject({ ok: true, ingested: 1, found: 1, queries_run: 2 });
  });

  it("denies a caller who does not own the folder before touching Gmail", async () => {
    seedScanFolder();
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_A, field: "from", op: "contains", value: "acme" },
    ]);
    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(scanGmailForFolder, "intruder")({ data: { folder_id: FOLDER_A } }),
      rejects: "Not authorized for this folder",
    });
    expect(listMessages).not.toHaveBeenCalled();
    expect(upsertEmailEncrypted).not.toHaveBeenCalled();
  });

  it("reports a missing folder rather than scanning the account", async () => {
    await expect(scanGmailForFolder({ data: { folder_id: FOLDER_A } })).rejects.toThrow(
      "Folder not found",
    );
    expect(listMessages).not.toHaveBeenCalled();
  });
});
