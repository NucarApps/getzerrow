// Write CONTRACTS for the user-directed / mirror folder writers — audit
// paths 9, 10 and 12 in docs/rules-engine-audit.md §1 (path 11, reconcile,
// is pinned in ./reconcile.test.ts "folder_id contract"). These paths
// deliberately override the rules ladder, so the question is not "do they
// agree with the oracle" but "what exactly may each one write, and what
// must it never do":
//
//   * Path 9 — manual move (move-email.server.ts performMove,
//     gmail/folder-mgmt.functions.ts applyRecategorization): writes EXACTLY
//     the requested folder with manual_move provenance, rules never
//     consulted. The reference behavior for this trigger is decideFolder's
//     manual short-circuit, which REFUSES a paused destination — and the
//     real sites don't consult it (pinned below as the audit's bug class).
//     The strip/inbox variants' distinct provenance values are pinned in
//     sibling suites: manual_strip in gmail/reprocess.functions.test.ts
//     ("clears then refiles nothing") and manual_inbox in
//     gmail/move.functions.test.ts (moveEmailToInbox).
//
//   * Path 10 — scheduled actions (sync/scheduled-actions.ts): the
//     side-effect patch may touch ONLY is_archived / is_read / folder_id,
//     and folder_id only ever gets the action's CONFIGURED
//     move_to_folder_id verbatim — never a rules-derived folder, never
//     null, and never any provenance columns.
//
//   * Path 12 — classification feedback
//     (sync/classification-feedback.functions.ts): a correction re-routes
//     through the SAME performMove core as a manual drag, records a
//     "feedback" folder example, and is ownership-scoped; but on the
//     emails row it is indistinguishable from a plain manual move (pinned
//     — audit §3's missing-provenance finding).
//
// Harness: __fixtures__/server-fn-stub makes each createServerFn export a
// plain callable (context.userId = TEST_USER, overridable per call);
// __fixtures__/supabase-fake backs supabaseAdmin, and a second fake plays
// the RLS-scoped context.supabase client for path 12.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import { makeEmailRow, makeFolder, makeRule } from "@/lib/__fixtures__/email-row";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";
import type { AccountContext } from "./account-context";

const fake = makeSupabaseFake();
/** RLS-scoped client handed to path-12 handlers as context.supabase. */
const rls = makeSupabaseFake();

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

// -- Gmail API surface -----------------------------------------------------
const modifyMessage = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../gmail.server", () => ({
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  modifyMessage: (...args: unknown[]) => modifyMessage(...args),
  batchModifyMessages: vi.fn(),
  trashMessage: vi.fn(),
  sendMessage: vi.fn(),
  createDraft: vi.fn(),
  ensureWatch: vi.fn(),
  stopWatch: vi.fn(),
  listMessages: vi.fn(),
  getMessage: vi.fn(),
  getMessageMetadata: vi.fn(),
  getMessageLabels: vi.fn(),
  getThread: vi.fn(),
  parseMessage: vi.fn(),
}));

vi.mock("../log.server", () => ({
  logError: () => {},
  logInfo: () => {},
  logAudit: () => {},
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

const regenerateFolderProfile = vi.fn(async (_folderId: string) => undefined);
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
  invalidateAccountContextForUser: vi.fn(),
  bulkCatchupClaim: vi.fn(),
  syncReadState: vi.fn(),
  classifyParsedEmail: vi.fn(),
  loadAccountContext: vi.fn(),
  regenerateFolderProfile: (folderId: string) => regenerateFolderProfile(folderId),
}));

const updateEmailEncrypted = vi.fn(async (_input: unknown) => ({ error: null as string | null }));
const insertFolderExampleEncrypted = vi.fn(async (_input: unknown) => ({
  id: "ex-1",
  error: null,
}));
vi.mock("./encrypted-writer", () => ({
  upsertEmailEncrypted: vi.fn(),
  updateEmailEncrypted: (input: unknown) => updateEmailEncrypted(input),
  setReplyDraftEncrypted: vi.fn(),
  setContactEncryptedFields: vi.fn(),
  insertFolderExampleEncrypted: (input: unknown) => insertFolderExampleEncrypted(input),
}));

const getEmailsDecrypted = vi.fn(async (_ids: string[]) => ({
  rows: [] as Array<Record<string, unknown>>,
  error: null as string | null,
}));
vi.mock("./encrypted-reader", () => ({
  getEmailsDecrypted: (ids: string[]) => getEmailsDecrypted(ids),
}));

import { performMove } from "../move-email.server";
import { applyRecategorization } from "../gmail/folder-mgmt.functions";
import { flagWrongClassification } from "./classification-feedback.functions";
import { runScheduledActions } from "./scheduled-actions";
import { dispatchFolderActions, type FolderActionRow } from "./action-dispatch";
import { decideFolder } from "./decide-folder";

const EMAIL_1 = "11111111-1111-4111-8111-111111111111";
const FOLDER_TO = "33333333-3333-4333-8333-333333333333";
const FOLDER_FROM = "44444444-4444-4444-8444-444444444444";
const EXEC_1 = "55555555-5555-4555-8555-555555555555";
const ATTACKER = "attacker-1";

/** Call a stubbed server fn with a full context override (userId AND the
 * RLS client) — impersonate() only overrides userId. */
function callWith(fn: unknown, args: { data?: unknown; context?: Record<string, unknown> }) {
  return (fn as (a?: unknown) => Promise<unknown>)(args);
}

function emailSelects(table: string) {
  return fake.calls.selects.filter((s) => s.table === table);
}
function emailUpdates() {
  return fake.calls.updates.filter((u) => u.table === "emails");
}

function seedMovableEmail(overrides: Record<string, unknown> = {}) {
  fake.seed("emails", [
    {
      id: EMAIL_1,
      user_id: TEST_USER,
      folder_id: FOLDER_FROM,
      gmail_message_id: "gm-1",
      gmail_account_id: "acc-1",
      from_addr: "boss@acme.com",
      raw_labels: ["INBOX", "L-FROM", "KEEP"],
      ...overrides,
    },
  ]);
}

function seedFolders(toOverrides: Record<string, unknown> = {}) {
  fake.seed("folders", [
    {
      id: FOLDER_TO,
      user_id: TEST_USER,
      name: "Receipts",
      gmail_label_id: "L-TO",
      ...toOverrides,
    },
    { id: FOLDER_FROM, user_id: TEST_USER, name: "Newsletters", gmail_label_id: "L-FROM" },
  ]);
}

function baseContext(over: Partial<AccountContext> = {}): AccountContext {
  return {
    folders: [],
    filters: [],
    overrides: [],
    overrideExceptions: [],
    enrichedFolders: [],
    calendarGuardEnabled: false,
    calendarContacts: new Set(),
    accountEmail: "me@example.com",
    senderGroups: new Map(),
    ...over,
  };
}

beforeEach(() => {
  fake.reset();
  rls.reset();
  modifyMessage.mockResolvedValue({});
  updateEmailEncrypted.mockResolvedValue({ error: null });
  insertFolderExampleEncrypted.mockResolvedValue({ id: "ex-1", error: null });
  getEmailsDecrypted.mockResolvedValue({ rows: [], error: null });
});

// ───────────────────────────────────────────────────────────────────────────
// Path 9 — manual move (hard override of the ladder)
// ───────────────────────────────────────────────────────────────────────────

describe("path 9 — manual move writes exactly the requested folder", () => {
  it("performMove writes the requested folder with manual_move provenance and never consults rules", async () => {
    seedMovableEmail();
    seedFolders();
    // A rule that routes this exact sender somewhere ELSE. A manual move is
    // a hard override: the rule must neither redirect nor even be read.
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: FOLDER_FROM, field: "from", op: "contains", value: "boss@acme.com" },
    ]);

    const res = await performMove(TEST_USER, EMAIL_1, FOLDER_TO);
    expect(res).toEqual({ ok: true });

    // The folder write goes through the encrypted writer with exactly the
    // requested destination and manual provenance.
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: EMAIL_1,
      folder_id: FOLDER_TO,
      classified_by: "manual_move",
      ai_confidence: 1,
      classification_reason: 'Re-categorized from "Newsletters" to "Receipts"',
    });

    // Rules, overrides and the ladder are never consulted — only the email
    // row and the two folders are read.
    expect(emailSelects("folder_filters")).toHaveLength(0);
    expect(emailSelects("inbox_overrides")).toHaveLength(0);
    const touched = new Set(fake.calls.selects.map((s) => s.table));
    expect([...touched].sort()).toEqual(["emails", "folders"]);

    // The plain-column patch never carries folder_id or provenance — those
    // live on the encrypted write above.
    expect(emailUpdates()).toHaveLength(1);
    expect(Object.keys(emailUpdates()[0]!.payload as object).sort()).toEqual([
      "is_archived",
      "raw_labels",
    ]);
  });

  it("reference ladder: decideFolder's manual trigger refuses a paused destination but honors an active one verbatim", () => {
    const parsed = makeEmailRow({ from_addr: "boss@acme.com" });
    const active = makeFolder({ id: FOLDER_TO, name: "Receipts" });
    const paused = makeFolder({ id: FOLDER_TO, name: "Receipts", processing_enabled: false });
    // Even a rule pointing at ANOTHER folder is ignored on the manual trigger.
    const elsewhere = makeRule(FOLDER_FROM, "from", "contains", "boss@acme.com");

    const ok = decideFolder(
      parsed,
      baseContext({
        folders: [active, makeFolder({ id: FOLDER_FROM, name: "Newsletters" })],
        filters: [elsewhere],
      }),
      { trigger: "manual", manualFolderId: FOLDER_TO },
    );
    expect(ok.folder_id).toBe(FOLDER_TO);
    expect(ok.classified_by).toBe("manual_move");
    expect(ok.ai_confidence).toBe(1);
    expect(ok.trace?.tiebreak).toBe("You chose this folder — rules were not consulted");

    const refused = decideFolder(parsed, baseContext({ folders: [paused] }), {
      trigger: "manual",
      manualFolderId: FOLDER_TO,
    });
    expect(refused.folder_id).toBeNull();
    expect(refused.classified_by).toBe("none");
    expect(refused.classification_reason).toContain("paused");
  });

  it("performMove files into a PAUSED folder — the real manual path never consults decideFolder's paused rung", async () => {
    seedMovableEmail();
    seedFolders({ processing_enabled: false });

    const res = await performMove(TEST_USER, EMAIL_1, FOLDER_TO);

    // DIVERGENCE (audit §1 path 9, §6.6): decideFolder's manual
    // short-circuit refuses a paused destination ("a paused folder is
    // refused even for a manual move"), but performMove — the writer behind
    // moveEmailToFolder, bulkMoveEmails and flagWrongClassification — never
    // reads processing_enabled at all: the move succeeds and the paused
    // folder is written. This is the audit's exact bug class (a manual site
    // writing without the rung-1 check); pinned as current behavior.
    expect(res).toEqual({ ok: true });
    expect(updateEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({ folder_id: FOLDER_TO, classified_by: "manual_move" }),
    );
    // The folders read doesn't even fetch the pause flag.
    const folderSelect = emailSelects("folders")[0];
    expect(folderSelect?.columns).toBe("id, user_id, name, gmail_label_id");
    expect(folderSelect?.columns).not.toContain("processing_enabled");
  });

  it("applyRecategorization (folder-mgmt.functions.ts:344) writes manual_move directly and also ignores the paused rung", async () => {
    seedMovableEmail();
    seedFolders({ processing_enabled: false });

    const res = await applyRecategorization({
      data: {
        email_id: EMAIL_1,
        to_folder_id: FOLDER_TO,
        apply_source: false,
        apply_target: false,
      },
    });
    expect(res).toEqual({ moved: 1, source_updated: false, target_updated: false });

    // Same manual_move provenance as performMove, but written by a second,
    // independent code path (it does NOT route through performMove)...
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: EMAIL_1,
      folder_id: FOLDER_TO,
      classified_by: "manual_move",
      ai_confidence: 1,
      classification_reason: 'Re-categorized from "Newsletters" to "Receipts"',
    });
    // ...that also duplicates folder_id + provenance onto the plain columns.
    expect(emailUpdates()).toHaveLength(1);
    expect(emailUpdates()[0]!.payload).toEqual({
      folder_id: FOLDER_TO,
      classified_by: "manual_move",
      ai_confidence: 1,
    });
    // DIVERGENCE (audit §1 path 9): the target folder is paused
    // (processing_enabled false) and the write went through anyway — like
    // performMove, this manual site never consults decideFolder's rung 1.
  });

  it("applyRecategorization denies a cross-user caller before any write", async () => {
    seedMovableEmail();
    seedFolders();
    await expectDeniedCrossUser({
      fake,
      call: () =>
        callWith(applyRecategorization, {
          data: {
            email_id: EMAIL_1,
            to_folder_id: FOLDER_TO,
            apply_source: false,
            apply_target: false,
          },
          context: { userId: ATTACKER },
        }),
      rejects: "Email not found",
    });
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
  });

  // decide-folder.ts carries a full manual-move short-circuit (trigger
  // "manual" + manualFolderId): it refuses a paused destination and stamps
  // its own trace. NOTHING calls it. The real manual move is performMove
  // above, which does none of that — so a paused folder IS a valid manual
  // destination today, and the "refuses a paused destination" behaviour
  // specified in decide-folder.test.ts is aspirational.
  //
  // This scan is the tripwire between the two. The day someone routes a
  // manual move through decideFolder, this fails and the ladder contract
  // stops being aspirational: promote it into a real path-9 assertion here
  // (a paused destination must be refused) and delete this test.
  it("no production caller routes a manual move through decideFolder", () => {
    const root = process.cwd();
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "node_modules" && name !== "__fixtures__") walk(full, out);
          continue;
        }
        if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
      }
      return out;
    };
    const callers = walk(join(root, "src"))
      .filter((file) => {
        if (file.endsWith(`${sep}decide-folder.ts`)) return false;
        const src = readFileSync(file, "utf8");
        return /trigger:\s*"manual"/.test(src) || /\bmanualFolderId\s*:/.test(src);
      })
      .map((f) => f.slice(root.length + 1));

    expect(
      callers,
      "these files hand decideFolder a manual move. Its manual rung refuses a " +
        "paused destination, which performMove (the real path 9) does not — so " +
        "the two now disagree. Assert the refusal here as a path-9 contract and " +
        "retire this scan",
    ).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Path 10 — scheduled actions side-effect patch
// ───────────────────────────────────────────────────────────────────────────

describe("path 10 — scheduled actions may only touch flags and the configured move target", () => {
  it("characterization: the dispatcher's row patch is limited to is_archived / is_read / folder_id, with zero provenance", async () => {
    const actions: FolderActionRow[] = [
      {
        id: "a1",
        action_type: "archive",
        label_id: null,
        move_to_folder_id: null,
        delay_minutes: 0,
      },
      {
        id: "a2",
        action_type: "mark_read",
        label_id: null,
        move_to_folder_id: null,
        delay_minutes: 0,
      },
      { id: "a3", action_type: "star", label_id: null, move_to_folder_id: null, delay_minutes: 0 },
      {
        id: "a4",
        action_type: "label",
        label_id: "L-X",
        move_to_folder_id: null,
        delay_minutes: 0,
      },
      {
        id: "a5",
        action_type: "move_folder",
        label_id: null,
        move_to_folder_id: FOLDER_TO,
        delay_minutes: 0,
      },
    ];
    const { plan, outcomes } = await dispatchFolderActions({
      actions,
      parsed: { raw_labels: ["INBOX", "UNREAD"] },
      inInbox: true,
      persistFlags: true,
      emailRowId: EMAIL_1,
      userId: TEST_USER,
      resolveMoveTarget: async () => ({ gmail_label_id: "L-DEST" }),
    });

    // Every implemented label-type action at once — this is the complete
    // field surface the scheduled-actions patch can ever touch.
    expect(plan.patch).toEqual({
      is_archived: true,
      is_read: true,
      folder_id: FOLDER_TO,
    });
    // folder_id is the CONFIGURED move_to_folder_id verbatim — the
    // dispatcher has no access to rules, so it can never derive a folder,
    // and no action type produces folder_id: null.
    // DIVERGENCE (audit §1 path 10 "side-effect patch that can clear
    // folder"): the current dispatcher/runner never clears folder_id — it
    // only sets the configured target or leaves the column alone.
    expect(plan.patch.folder_id).toBe(FOLDER_TO);
    for (const key of Object.keys(plan.patch)) {
      expect(["is_archived", "is_read", "folder_id"]).toContain(key);
    }
    // No provenance travels with the patch: the row keeps whatever
    // classified_by / classification_reason it had (audit §3 — this write
    // is invisible to the explain drawer).
    expect(plan.patch).not.toHaveProperty("classified_by");
    expect(plan.patch).not.toHaveProperty("classification_reason");
    expect(plan.patch).not.toHaveProperty("decision_trace");
    expect(outcomes.every((o) => o.status === "applied")).toBe(true);
    expect(plan.addLabels).toEqual(["STARRED", "L-X", "L-DEST"]);
    expect(plan.removeLabels).toEqual(["INBOX", "UNREAD"]);
  });

  it("a scheduled move_folder writes only the configured destination — even when that destination is paused", async () => {
    fake.onRpc("claim_scheduled_actions", () => ({
      data: [
        { id: "job-m", user_id: "user-1", folder_action_id: "act-m", email_id: "e1", attempt: 1 },
      ],
    }));
    fake.seed("folder_actions", [
      {
        id: "act-m",
        folder_id: "f-own",
        action_type: "move_folder",
        label_id: null,
        move_to_folder_id: FOLDER_TO,
        enabled: true,
      },
    ]);
    fake.seed("folders", [
      { id: "f-own", processing_enabled: true },
      // The DESTINATION is paused — pinning that the runner only checks the
      // action's OWNING folder for pause, never the move target.
      { id: FOLDER_TO, gmail_label_id: "L-DEST", processing_enabled: false },
    ]);
    getEmailsDecrypted.mockResolvedValue({
      rows: [
        {
          id: "e1",
          gmail_account_id: "acc-1",
          gmail_message_id: "gm-1",
          raw_labels: ["INBOX"],
          is_archived: false,
        },
      ],
      error: null,
    });

    const result = await runScheduledActions(5);
    expect(result).toMatchObject({ claimed: 1, done: 1 });

    // The emails patch is EXACTLY the configured destination — nothing else.
    expect(emailUpdates()).toHaveLength(1);
    expect(emailUpdates()[0]!.payload).toEqual({ folder_id: FOLDER_TO });
    expect(modifyMessage).toHaveBeenCalledWith("acc-1", "gm-1", ["L-DEST"], []);

    // Rules were never consulted, and the destination's pause flag was
    // never even read (only gmail_label_id is fetched for the target).
    expect(emailSelects("folder_filters")).toHaveLength(0);
    const destSelects = fake.calls.selects.filter(
      (s) =>
        s.table === "folders" &&
        s.filters.some((f) => f.op === "eq" && f.col === "id" && f.value === FOLDER_TO),
    );
    expect(destSelects).toHaveLength(1);
    expect(destSelects[0]!.columns).toBe("gmail_label_id");
  });

  it("a paused OWNING folder turns the job into a quiet no-op: done, zero email writes, zero Gmail calls", async () => {
    fake.onRpc("claim_scheduled_actions", () => ({
      data: [
        { id: "job-p", user_id: "user-1", folder_action_id: "act-p", email_id: "e1", attempt: 1 },
      ],
    }));
    fake.seed("folder_actions", [
      {
        id: "act-p",
        folder_id: "f-own",
        action_type: "move_folder",
        label_id: null,
        move_to_folder_id: FOLDER_TO,
        enabled: true,
      },
    ]);
    fake.seed("folders", [{ id: "f-own", processing_enabled: false }]);

    const result = await runScheduledActions(5);
    expect(result).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect(emailUpdates()).toHaveLength(0);
    expect(modifyMessage).not.toHaveBeenCalled();
    expect(getEmailsDecrypted).not.toHaveBeenCalled();
    const jobDone = fake.calls.updates.find((u) => u.table === "scheduled_actions");
    expect(jobDone?.payload).toMatchObject({ status: "done" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Path 12 — classification feedback
// ───────────────────────────────────────────────────────────────────────────

describe("path 12 — classification feedback re-routes through performMove", () => {
  function seedFeedbackWorld() {
    fake.seed("executed_rules", [
      {
        id: EXEC_1,
        user_id: TEST_USER,
        gmail_account_id: "acc-1",
        email_id: EMAIL_1,
        gmail_message_id: "gm-1",
        folder_id: FOLDER_FROM,
        classified_by: "ai",
        ai_confidence: 0.9,
        matched_leaf_json: null,
      },
    ]);
    seedMovableEmail();
    seedFolders();
    // RLS view: the caller owns the corrected folder.
    rls.seed("folders", [{ id: FOLDER_TO }]);
    getEmailsDecrypted.mockResolvedValue({
      rows: [
        {
          id: EMAIL_1,
          user_id: TEST_USER,
          from_addr: "boss@acme.com",
          subject: "s",
          snippet: "sn",
        },
      ],
      error: null,
    });
  }

  it("a correction writes the corrected folder via performMove and records a 'feedback' example", async () => {
    seedFeedbackWorld();
    const res = await callWith(flagWrongClassification, {
      data: { executed_rule_id: EXEC_1, correct_folder_id: FOLDER_TO, note: "wrong" },
      context: { supabase: rls.supabaseAdmin },
    });
    expect(res).toEqual({ ok: true, moved: true });

    // The feedback row is inserted through the RLS client as the caller.
    const feedbackInserts = rls.calls.inserts.filter((i) => i.table === "classification_feedback");
    expect(feedbackInserts).toHaveLength(1);
    expect(feedbackInserts[0]!.payload).toEqual({
      user_id: TEST_USER,
      executed_rule_id: EXEC_1,
      correct_folder_id: FOLDER_TO,
      note: "wrong",
    });

    // The folder write is performMove's — corrected folder, manual
    // provenance, the caller's correction reason.
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: EMAIL_1,
      folder_id: FOLDER_TO,
      classified_by: "manual_move",
      ai_confidence: 1,
      classification_reason: "user flagged wrong classification",
    });

    // Two few-shot examples land: performMove's "correction" plus this
    // path's "feedback", both on the corrected folder.
    const sources = insertFolderExampleEncrypted.mock.calls.map(
      (c) => c[0] as { source: string; folder_id: string },
    );
    expect(sources.map((s) => s.source)).toEqual(["correction", "feedback"]);
    expect(sources.every((s) => s.folder_id === FOLDER_TO)).toBe(true);
  });

  it("pins the provenance gap: no decision_trace anywhere, and the row is indistinguishable from a plain manual move", async () => {
    seedFeedbackWorld();
    await callWith(flagWrongClassification, {
      data: { executed_rule_id: EXEC_1, correct_folder_id: FOLDER_TO },
      context: { supabase: rls.supabaseAdmin },
    });

    // DIVERGENCE (audit §3): a user CORRECTION should carry provenance
    // distinguishing "user placed it" from a routine drag, and a trace —
    // but this path writes classified_by "manual_move" (performMove's
    // value, not a feedback-specific one) and decision_trace is never
    // written. Pinned as current behavior.
    const allWrites = [
      ...fake.calls.inserts,
      ...fake.calls.updates,
      ...fake.calls.upserts,
      ...rls.calls.inserts,
      ...rls.calls.updates,
      ...updateEmailEncrypted.mock.calls.map((c) => ({ payload: c[0] })),
    ];
    for (const w of allWrites) {
      expect(w.payload ?? {}).not.toHaveProperty("decision_trace");
    }
    const encWrite = updateEmailEncrypted.mock.calls[0]![0] as { classified_by: string };
    expect(encWrite.classified_by).toBe("manual_move");
  });

  it("denies a cross-user caller on the executed rule (ownership scoping) with zero writes", async () => {
    seedFeedbackWorld();
    await expectDeniedCrossUser({
      fake,
      call: () =>
        callWith(flagWrongClassification, {
          data: { executed_rule_id: EXEC_1, correct_folder_id: FOLDER_TO },
          context: { userId: ATTACKER, supabase: rls.supabaseAdmin },
        }),
      rejects: "Execution not found",
    });
    expect(rls.calls.inserts).toHaveLength(0);
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
  });

  it("refuses a folder the RLS client cannot see, before the feedback insert or any move", async () => {
    seedFeedbackWorld();
    rls.seed("folders", []); // corrected folder not visible to the caller
    await expect(
      callWith(flagWrongClassification, {
        data: { executed_rule_id: EXEC_1, correct_folder_id: FOLDER_TO },
        context: { supabase: rls.supabaseAdmin },
      }),
    ).rejects.toThrow("Folder not found");
    expect(rls.calls.inserts).toHaveLength(0);
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
    expect(emailUpdates()).toHaveLength(0);
  });
});
