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
const modifyMessage = vi.fn(async (..._args: unknown[]) => ({}));
const batchModifyMessages = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../gmail.server", () => ({
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  modifyMessage: (...args: unknown[]) => modifyMessage(...args),
  batchModifyMessages: (...args: unknown[]) => batchModifyMessages(...args),
  trashMessage: vi.fn(),
  sendMessage: vi.fn(),
  ensureWatch: vi.fn(),
  stopWatch: vi.fn(),
  listMessages: vi.fn(async () => ({ messages: [] })),
  getMessage: vi.fn(),
  getMessageMetadata: vi.fn(),
  getMessageLabels: vi.fn(),
  getThread: vi.fn(),
  parseMessage: vi.fn(() => ({})),
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

vi.mock("../ai.server", () => ({
  suggestFolderFromEmails: vi.fn(async () => ({ name: "Suggested" })),
}));

vi.mock("../log.server", () => ({
  logError: () => {},
  logInfo: () => {},
  logAudit: () => {},
}));

const upsertEmailEncrypted = vi.fn(async (_input: unknown) => ({
  id: "db-x",
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
  createFolderAndAssign,
  reclassifyEmails,
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
    classifyParsedEmail,
    invalidateAccountContext,
    performMove,
    upsertEmailEncrypted,
    updateEmailEncrypted,
    getEmailsDecrypted,
  ])
    fn.mockClear();
  modifyMessage.mockResolvedValue({});
  batchModifyMessages.mockResolvedValue({});
  classifyParsedEmail.mockResolvedValue({ folder_id: null, classified_by: "none" });
  performMove.mockResolvedValue({ ok: true });
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
