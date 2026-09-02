// Unit tests for the folder-management server functions.
//
// applyRecategorization is audit path 9 in docs/rules-engine-audit.md §1
// ("manual move / strip"): a user-directed override of the classifier
// ladder. Being user-directed does not make it unconstrained — what is
// pinned here is the exact shape of the correction it records, because
// three separate stores have to agree afterwards:
//
//   * the emails row (folder_id + classified_by "manual_move" +
//     ai_confidence 1 — a manual move is certain by construction),
//   * Gmail's labels (target label added, source label removed) — a
//     BEST-EFFORT mirror, so a Gmail outage must not roll back the DB,
//   * folder_examples, where the example is MOVED from source to target
//     with source "correction" so the folder-learning signal reflects the
//     user's correction rather than the mistake.
//
// The rest of the module is ordinary CRUD whose contracts still matter:
// updateFolderSummary decides when a schedule's next_run_at is recomputed
// (get it wrong and a digest either fires at the old time or never),
// getFolderHealth's bucketing is what the accuracy panel reports,
// listFolderHistory pages with a limit+1 probe, and createFolder is the
// single writer for a new folder's inert defaults.
//
// Harness: __fixtures__/server-fn-stub makes each createServerFn export a
// plain callable with context.userId = TEST_USER (overridable per call for
// impersonation checks); __fixtures__/supabase-fake backs supabaseAdmin.
// gmail-helpers.server (getOwnedAccount / getOwnedFolder / getOwnedSchedule)
// is REAL, so the ownership checks are exercised rather than assumed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writesTo } from "@/lib/__fixtures__/supabase-fake";
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
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

// -- Gmail API surface ------------------------------------------------------
const modifyMessage = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../gmail.server", () => ({
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  modifyMessage: (...args: unknown[]) => modifyMessage(...args),
  batchModifyMessages: vi.fn(),
  trashMessage: vi.fn(),
  sendMessage: vi.fn(),
  insertMessage: vi.fn(),
  ensureWatch: vi.fn(),
  stopWatch: vi.fn(),
  listMessages: vi.fn(),
  getMessage: vi.fn(),
  getMessageMetadata: vi.fn(),
  getMessageLabels: vi.fn(),
  getThread: vi.fn(),
  parseMessage: vi.fn(),
}));

// gmail-helpers.server (real) pulls in sync.server; only bulkCatchupClaim is
// referenced, and nothing here reaches it.
vi.mock("../sync.server", () => ({
  bulkCatchupClaim: vi.fn(),
}));

const suggestRuleUpdates = vi.fn(async (_args: unknown): Promise<Record<string, unknown>> => ({
  source: { proposed_rule: "s", proposed_profile: "sp", why: "sw" },
  target: { proposed_rule: "t", proposed_profile: "tp", why: "tw" },
}));
vi.mock("../ai.server", () => ({
  suggestRuleUpdates: (args: unknown) => suggestRuleUpdates(args),
}));

const NEXT_RUN = new Date("2026-09-03T11:30:00.000Z");
const computeNextRun = vi.fn(
  (_hour: number, _minute: number, _tz: string): Date => new Date(NEXT_RUN),
);
const enqueueFolderSummaryJob = vi.fn(async (_args: unknown) => ({ jobId: "job-1" }));
vi.mock("../summaries.server", () => ({
  computeNextRun: (hour: number, minute: number, tz: string) => computeNextRun(hour, minute, tz),
  enqueueFolderSummaryJob: (args: unknown) => enqueueFolderSummaryJob(args),
}));

vi.mock("../log.server", () => ({
  logError: () => {},
  logInfo: () => {},
  logAudit: () => {},
}));

const updateEmailEncrypted = vi.fn(async (_input: unknown) => ({ error: null as string | null }));
const insertFolderExampleEncrypted = vi.fn(async (_input: unknown) => ({
  id: "ex-1" as string | null,
  error: null as string | null,
}));
vi.mock("../sync/encrypted-writer", () => ({
  upsertEmailEncrypted: vi.fn(),
  updateEmailEncrypted: (input: unknown) => updateEmailEncrypted(input),
  setReplyDraftEncrypted: vi.fn(),
  insertFolderExampleEncrypted: (input: unknown) => insertFolderExampleEncrypted(input),
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
  applyRecategorization,
  createFolder,
  getFolderHealth,
  listFolderHistory,
  updateFolderSummary,
} from "./folder-mgmt.functions";

const ACC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMAIL_1 = "11111111-1111-4111-8111-111111111111";
const EMAIL_2 = "22222222-2222-4222-8222-222222222222";
const EMAIL_3 = "33333333-3333-4333-8333-333333333333";
const FOLDER_A = "55555555-5555-4555-8555-555555555555";
const FOLDER_B = "66666666-6666-4666-8666-666666666666";
const SCHEDULE = "77777777-7777-4777-8777-777777777777";
const NEW_FOLDER = "99999999-9999-4999-8999-999999999999";

const NOW = new Date("2026-09-02T10:00:00.000Z");

beforeEach(() => {
  fake.reset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("EMAIL_ENC_KEY", "test-enc-key");
  for (const fn of [
    modifyMessage,
    suggestRuleUpdates,
    computeNextRun,
    enqueueFolderSummaryJob,
    updateEmailEncrypted,
    insertFolderExampleEncrypted,
    getEmailsDecrypted,
  ])
    fn.mockClear();
  modifyMessage.mockResolvedValue({});
  updateEmailEncrypted.mockResolvedValue({ error: null });
  insertFolderExampleEncrypted.mockResolvedValue({ id: "ex-1", error: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** The email being re-categorized, filed in FOLDER_A. */
function seedRecategorization(over: Record<string, unknown> = {}) {
  fake.seed("emails", [
    {
      id: EMAIL_1,
      user_id: TEST_USER,
      folder_id: FOLDER_A,
      gmail_message_id: "gm-1",
      gmail_account_id: ACC,
      from_addr: "a@acme.com",
      ...over,
    },
  ]);
}

function seedFolderPair(
  over: { from?: Record<string, unknown>; to?: Record<string, unknown> } = {},
) {
  fake.seed("folders", [
    {
      id: FOLDER_A,
      user_id: TEST_USER,
      name: "Receipts",
      gmail_label_id: "L-A",
      ...over.from,
    },
    {
      id: FOLDER_B,
      user_id: TEST_USER,
      name: "Invoices",
      gmail_label_id: "L-B",
      ...over.to,
    },
  ]);
}

describe("applyRecategorization (audit path 9 — user-directed correction)", () => {
  it("files the email, mirrors the labels, and moves the learning example to the target", async () => {
    seedRecategorization();
    seedFolderPair();

    const res = await applyRecategorization({
      data: {
        email_id: EMAIL_1,
        to_folder_id: FOLDER_B,
        apply_source: false,
        apply_target: false,
      },
    });
    expect(res).toEqual({ moved: 1, source_updated: false, target_updated: false });

    // A manual move is certain by construction: full confidence, and the
    // reason names both folders so the history panel can explain itself.
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: EMAIL_1,
      folder_id: FOLDER_B,
      classified_by: "manual_move",
      ai_confidence: 1,
      classification_reason: 'Re-categorized from "Receipts" to "Invoices"',
    });
    const emailUpdates = writesTo(fake, "updates", "emails");
    expect(emailUpdates).toHaveLength(1);
    expect(emailUpdates[0]!.payload).toEqual({
      folder_id: FOLDER_B,
      classified_by: "manual_move",
      ai_confidence: 1,
    });
    expect(emailUpdates[0]!.filters).toEqual([{ op: "eq", col: "id", value: EMAIL_1 }]);

    // Gmail mirror: target label on, source label off, in one call.
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-1", ["L-B"], ["L-A"]);

    // The example is MOVED, not copied: deleted from the source folder…
    const deletes = writesTo(fake, "deletes", "folder_examples");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.filters).toEqual([
      { op: "eq", col: "folder_id", value: FOLDER_A },
      { op: "eq", col: "gmail_message_id", value: "gm-1" },
    ]);
    // …and re-inserted against the target, tagged as a correction so folder
    // learning can weight it differently from ordinary seed examples.
    expect(insertFolderExampleEncrypted).toHaveBeenCalledWith({
      folder_id: FOLDER_B,
      user_id: TEST_USER,
      gmail_message_id: "gm-1",
      gmail_account_id: ACC,
      from_addr: "a@acme.com",
      subject: null,
      snippet: null,
      source: "correction",
    });

    // Neither folder's rule was asked for, so neither folder row is touched.
    expect(writesTo(fake, "updates", "folders")).toHaveLength(0);
  });

  it("patches only the rule fields the caller supplied, and clears one asked for explicitly", async () => {
    seedRecategorization();
    seedFolderPair();

    const res = await applyRecategorization({
      data: {
        email_id: EMAIL_1,
        to_folder_id: FOLDER_B,
        apply_source: true,
        apply_target: true,
        // Source: clear the rule, leave the profile alone.
        source_rule: null,
        // Target: set the rule, clear the profile.
        target_rule: "Invoices and receipts from vendors.",
        target_profile: null,
      },
    });
    expect(res).toEqual({ moved: 1, source_updated: true, target_updated: true });

    const folderUpdates = writesTo(fake, "updates", "folders");
    expect(folderUpdates).toHaveLength(2);
    // An omitted key is left out of the patch entirely (leave alone); an
    // explicit null is carried through as a clear.
    expect(folderUpdates[0]!.payload).toEqual({
      last_learned_at: NOW.toISOString(),
      ai_rule: null,
    });
    expect(folderUpdates[0]!.filters).toEqual([{ op: "eq", col: "id", value: FOLDER_A }]);
    expect(folderUpdates[1]!.payload).toEqual({
      last_learned_at: NOW.toISOString(),
      ai_rule: "Invoices and receipts from vendors.",
      learned_profile: null,
    });
    expect(folderUpdates[1]!.filters).toEqual([{ op: "eq", col: "id", value: FOLDER_B }]);
  });

  it("keeps the DB correction when the Gmail label mirror fails", async () => {
    seedRecategorization();
    seedFolderPair();
    modifyMessage.mockRejectedValue(new Error("Gmail 503"));

    const res = await applyRecategorization({
      data: {
        email_id: EMAIL_1,
        to_folder_id: FOLDER_B,
        apply_source: false,
        apply_target: false,
      },
    });
    // The label sync is best-effort: the user's correction still lands, and
    // the next sync pass reconciles the mailbox.
    expect(res).toEqual({ moved: 1, source_updated: false, target_updated: false });
    expect(writesTo(fake, "updates", "emails")).toHaveLength(1);
    expect(insertFolderExampleEncrypted).toHaveBeenCalledTimes(1);
  });

  it("skips Gmail entirely when neither folder is linked to a label", async () => {
    seedRecategorization();
    seedFolderPair({ from: { gmail_label_id: null }, to: { gmail_label_id: null } });

    await applyRecategorization({
      data: {
        email_id: EMAIL_1,
        to_folder_id: FOLDER_B,
        apply_source: false,
        apply_target: false,
      },
    });
    expect(modifyMessage).not.toHaveBeenCalled();
  });

  it("refuses a target folder owned by another user before any write", async () => {
    seedRecategorization();
    seedFolderPair({ to: { user_id: "victim" } });

    await expectDeniedCrossUser({
      fake,
      call: () =>
        applyRecategorization({
          data: {
            email_id: EMAIL_1,
            to_folder_id: FOLDER_B,
            apply_source: true,
            apply_target: true,
            target_rule: "mine now",
          },
        }),
      rejects: "Not authorized",
    });
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
    expect(insertFolderExampleEncrypted).not.toHaveBeenCalled();
    expect(modifyMessage).not.toHaveBeenCalled();
  });

  it("refuses an email owned by another user", async () => {
    seedRecategorization({ user_id: "victim" });
    seedFolderPair();
    await expectDeniedCrossUser({
      fake,
      call: () =>
        applyRecategorization({
          data: {
            email_id: EMAIL_1,
            to_folder_id: FOLDER_B,
            apply_source: false,
            apply_target: false,
          },
        }),
      rejects: "Email not found",
    });
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
  });

  it("rejects a no-op move before it even looks the folders up", async () => {
    seedRecategorization();
    seedFolderPair();

    await expect(
      applyRecategorization({
        data: {
          email_id: EMAIL_1,
          to_folder_id: FOLDER_A, // same as the source
          apply_source: false,
          apply_target: false,
        },
      }),
    ).rejects.toThrow("Source and target folders must differ");
    // Only the email lookup ran — the folder pair was never fetched.
    expect(fake.calls.selects.map((s) => s.table)).toEqual(["emails"]);
  });

  it("rejects an email that is not filed anywhere", async () => {
    seedRecategorization({ folder_id: null });
    seedFolderPair();
    await expect(
      applyRecategorization({
        data: {
          email_id: EMAIL_1,
          to_folder_id: FOLDER_B,
          apply_source: false,
          apply_target: false,
        },
      }),
    ).rejects.toThrow("Email has no source folder");
  });
});

describe("updateFolderSummary (when a digest's next run is recomputed)", () => {
  function seedSchedule(over: Record<string, unknown> = {}) {
    fake.seed("folder_summary_schedules", [
      {
        id: SCHEDULE,
        user_id: TEST_USER,
        folder_id: FOLDER_A,
        hour: 7,
        minute: 30,
        timezone: "America/New_York",
        enabled: false,
        ...over,
      },
    ]);
  }
  const scheduleUpdates = () => writesTo(fake, "updates", "folder_summary_schedules");

  it("re-enabling a paused schedule recomputes the next run from its stored time", async () => {
    seedSchedule({ enabled: false });

    const res = await updateFolderSummary({ data: { id: SCHEDULE, enabled: true } });
    expect(res).toEqual({ ok: true });

    expect(computeNextRun).toHaveBeenCalledWith(7, 30, "America/New_York");
    expect(scheduleUpdates()).toHaveLength(1);
    expect(scheduleUpdates()[0]!.payload).toEqual({
      enabled: true,
      next_run_at: NEXT_RUN.toISOString(),
    });
    expect(scheduleUpdates()[0]!.filters).toEqual([{ op: "eq", col: "id", value: SCHEDULE }]);
  });

  it("changing one part of the time recomputes using the stored value for the rest", async () => {
    seedSchedule({ enabled: true });

    await updateFolderSummary({ data: { id: SCHEDULE, hour: 9 } });
    // Minute and timezone come from the existing row, not from a default.
    expect(computeNextRun).toHaveBeenCalledWith(9, 30, "America/New_York");
    expect(scheduleUpdates()[0]!.payload).toEqual({
      hour: 9,
      next_run_at: NEXT_RUN.toISOString(),
    });
  });

  it("a name-only patch leaves the schedule's next run exactly where it was", async () => {
    seedSchedule({ enabled: true });

    await updateFolderSummary({ data: { id: SCHEDULE, name: "Morning briefing" } });
    expect(computeNextRun).not.toHaveBeenCalled();
    expect(scheduleUpdates()[0]!.payload).toEqual({ name: "Morning briefing" });
  });

  it("re-asserting enabled on an already-enabled schedule does not slide its next run", async () => {
    seedSchedule({ enabled: true });

    await updateFolderSummary({ data: { id: SCHEDULE, enabled: true } });
    expect(computeNextRun).not.toHaveBeenCalled();
    expect(scheduleUpdates()[0]!.payload).toEqual({ enabled: true });
  });

  it("disabling a schedule does not recompute a next run for it", async () => {
    seedSchedule({ enabled: true });

    await updateFolderSummary({ data: { id: SCHEDULE, enabled: false } });
    expect(computeNextRun).not.toHaveBeenCalled();
    expect(scheduleUpdates()[0]!.payload).toEqual({ enabled: false });
  });

  it("surfaces a failed update instead of reporting success", async () => {
    seedSchedule({ enabled: true });
    fake.onUpdate("folder_summary_schedules", () => ({ message: "row is locked" }));
    await expect(updateFolderSummary({ data: { id: SCHEDULE, name: "x" } })).rejects.toThrow(
      "row is locked",
    );
  });

  it("denies a caller who does not own the schedule", async () => {
    seedSchedule({ user_id: "victim", enabled: false });
    await expectDeniedCrossUser({
      fake,
      call: () => updateFolderSummary({ data: { id: SCHEDULE, enabled: true } }),
      rejects: "Not authorized",
    });
  });
});

describe("getFolderHealth (how mail landed in a folder)", () => {
  it("buckets the sample by classifier, counting a sub-0.6 AI call as low confidence", async () => {
    fake.seed("folders", [
      {
        id: FOLDER_A,
        user_id: TEST_USER,
        emails_since_learn: 12,
        last_learned_at: "2026-08-01T00:00:00Z",
        learned_profile: "Vendor invoices",
        relearn_threshold: 50,
        auto_relearn: true,
      },
    ]);
    fake.seed("emails", [
      // Manual: the user put it here.
      { id: EMAIL_1, user_id: TEST_USER, folder_id: FOLDER_A, classified_by: "manual_move" },
      { id: EMAIL_2, user_id: TEST_USER, folder_id: FOLDER_A, classified_by: "manual_inbox" },
      // AI: one confident, one below the 0.6 line, one flagged by name.
      {
        id: "a1",
        user_id: TEST_USER,
        folder_id: FOLDER_A,
        classified_by: "ai",
        ai_confidence: 0.9,
      },
      {
        id: "a2",
        user_id: TEST_USER,
        folder_id: FOLDER_A,
        classified_by: "ai",
        ai_confidence: 0.4,
      },
      {
        id: "a3",
        user_id: TEST_USER,
        folder_id: FOLDER_A,
        classified_by: "ai_low_confidence",
        ai_confidence: 0.95,
      },
      // Deterministic rules, in all four spellings the panel recognizes.
      { id: "r1", user_id: TEST_USER, folder_id: FOLDER_A, classified_by: "filter" },
      { id: "r2", user_id: TEST_USER, folder_id: FOLDER_A, classified_by: "domain_rule" },
      { id: "r3", user_id: TEST_USER, folder_id: FOLDER_A, classified_by: "override" },
      { id: "r4", user_id: TEST_USER, folder_id: FOLDER_A, classified_by: "label" },
      // Anything else, including a row never classified at all.
      { id: "o1", user_id: TEST_USER, folder_id: FOLDER_A, classified_by: "pending" },
      { id: "o2", user_id: TEST_USER, folder_id: FOLDER_A, classified_by: null },
      // Out of scope: another folder, and another user's row in this folder.
      { id: EMAIL_3, user_id: TEST_USER, folder_id: FOLDER_B, classified_by: "filter" },
      { id: "x1", user_id: "someone-else", folder_id: FOLDER_A, classified_by: "filter" },
    ]);
    fake.seed("folder_examples", [
      {
        id: "e1",
        user_id: TEST_USER,
        folder_id: FOLDER_A,
        source: "manual_move",
        created_at: "2026-08-20T00:00:00Z",
      },
      {
        id: "e2",
        user_id: TEST_USER,
        folder_id: FOLDER_A,
        source: "manual_move",
        created_at: "2026-08-25T00:00:00Z",
      },
      // Seeded examples count toward the total but not toward corrections.
      {
        id: "e3",
        user_id: TEST_USER,
        folder_id: FOLDER_A,
        source: "seed",
        created_at: "2026-08-26T00:00:00Z",
      },
    ]);

    const res = await getFolderHealth({ data: { folder_id: FOLDER_A } });
    expect(res).toEqual({
      total: 11,
      sampled: 11,
      byRules: 4,
      byAi: 3,
      byManual: 2,
      other: 2,
      // 0.4 is under the line; ai_low_confidence counts on its name alone
      // even though its recorded confidence is high.
      lowConfidence: 2,
      avgConfidence: (0.9 + 0.4 + 0.95) / 3,
      learning: {
        examples: 3,
        recentCorrections: 2,
        lastCorrectionAt: "2026-08-25T00:00:00Z",
        lastLearnedAt: "2026-08-01T00:00:00Z",
        hasProfile: true,
        emailsSinceLearn: 12,
        relearnThreshold: 50,
        autoRelearn: true,
      },
    });
  });

  it("reports an empty folder without inventing an average confidence", async () => {
    fake.seed("folders", [
      {
        id: FOLDER_A,
        user_id: TEST_USER,
        emails_since_learn: 0,
        last_learned_at: null,
        learned_profile: null,
        relearn_threshold: 25,
        auto_relearn: false,
      },
    ]);

    const res = await getFolderHealth({ data: { folder_id: FOLDER_A } });
    expect(res).toEqual({
      total: 0,
      sampled: 0,
      byRules: 0,
      byAi: 0,
      byManual: 0,
      other: 0,
      lowConfidence: 0,
      avgConfidence: null,
      learning: {
        examples: 0,
        recentCorrections: 0,
        lastCorrectionAt: null,
        lastLearnedAt: null,
        hasProfile: false,
        emailsSinceLearn: 0,
        relearnThreshold: 25,
        autoRelearn: false,
      },
    });
  });

  it("denies a caller who does not own the folder", async () => {
    fake.seed("folders", [{ id: FOLDER_A, user_id: "victim" }]);
    await expect(getFolderHealth({ data: { folder_id: FOLDER_A } })).rejects.toThrow(
      "Not authorized",
    );
  });
});

describe("listFolderHistory (paged folder timeline)", () => {
  function seedHistory(n: number) {
    fake.seed(
      "emails",
      Array.from({ length: n }, (_, i) => ({
        id: `h-${i}`,
        user_id: TEST_USER,
        folder_id: FOLDER_A,
        from_addr: `s${i}@acme.com`,
        // Descending order is what the handler asks for; seed ascending so
        // the sort has to do the work.
        received_at: `2026-08-0${i + 1}T00:00:00Z`,
        classified_by: "filter",
        ai_confidence: 1,
      })),
    );
  }

  beforeEach(() => {
    fake.seed("folders", [{ id: FOLDER_A, user_id: TEST_USER }]);
  });

  it("fetches one row past the limit to detect a next page, and returns only the page", async () => {
    seedHistory(3);

    const res = await listFolderHistory({ data: { folder_id: FOLDER_A, limit: 2 } });
    expect(res.has_more).toBe(true);
    expect(res.next_offset).toBe(2);
    // The probe row is dropped from the returned page.
    expect(res.emails.map((e) => e.id)).toEqual(["h-2", "h-1"]);

    // limit+1 is asked for as an inclusive range, not a limit.
    const sel = fake.calls.selects.find((s) => s.table === "emails")!;
    expect(sel.range).toEqual([0, 2]);
    expect(sel.filters).toContainEqual({ op: "eq", col: "user_id", value: TEST_USER });
    expect(sel.filters).toContainEqual({ op: "eq", col: "folder_id", value: FOLDER_A });
  });

  it("reports no next page when the probe row comes back empty", async () => {
    seedHistory(2);

    const res = await listFolderHistory({ data: { folder_id: FOLDER_A, limit: 2 } });
    expect(res.has_more).toBe(false);
    expect(res.emails).toHaveLength(2);
    expect(res.next_offset).toBe(2);
  });

  it("joins the decrypted AI summary onto each row and nulls the fields it cannot read", async () => {
    seedHistory(1);
    fake.onRpc("get_emails_list_fields_decrypted", () => ({
      data: [{ id: "h-0", ai_summary: "Vendor invoice for August" }],
    }));

    const res = await listFolderHistory({ data: { folder_id: FOLDER_A, limit: 5 } });
    // toMatchObject rather than toEqual: the fake resolves whole seeded rows
    // where PostgREST would project the select list, so the row carries
    // columns the real query never returns.
    expect(res.emails).toHaveLength(1);
    expect(res.emails[0]).toMatchObject({
      id: "h-0",
      from_addr: "s0@acme.com",
      received_at: "2026-08-01T00:00:00Z",
      classified_by: "filter",
      ai_confidence: 1,
      // Encrypted columns are not read on this path — they are placeholders
      // the caller fills in elsewhere — except ai_summary, which comes back
      // from the decrypt RPC below.
      subject: null,
      from_name: null,
      snippet: null,
      ai_summary: "Vendor invoice for August",
    });
    expect(fake.calls.rpcs[0]).toEqual({
      fn: "get_emails_list_fields_decrypted",
      args: { p_ids: ["h-0"], p_key: "test-enc-key" },
    });
  });

  it("skips the decrypt round-trip entirely for an empty page", async () => {
    const res = await listFolderHistory({ data: { folder_id: FOLDER_A } });
    expect(res).toEqual({ emails: [], has_more: false, next_offset: 25 });
    expect(fake.calls.rpcs).toHaveLength(0);
  });

  it("pages from the requested offset with the default limit", async () => {
    seedHistory(1);
    const res = await listFolderHistory({ data: { folder_id: FOLDER_A, offset: 50 } });
    expect(res.next_offset).toBe(75);
    expect(fake.calls.selects.find((s) => s.table === "emails")!.range).toEqual([50, 75]);
  });

  it("denies a caller who does not own the folder", async () => {
    fake.seed("folders", [{ id: FOLDER_A, user_id: "victim" }]);
    await expect(listFolderHistory({ data: { folder_id: FOLDER_A } })).rejects.toThrow(
      "Not authorized",
    );
  });
});

describe("createFolder (the single writer for a new folder's defaults)", () => {
  beforeEach(() => {
    fake.seed("gmail_accounts", [{ id: ACC, user_id: TEST_USER }]);
    // The insert's .select("id").single() needs the DB-generated id.
    fake.onInsert("folders", () => ({ data: { id: NEW_FOLDER } }));
  });

  it("creates an inert folder: no rules, AI off, and the default colour", async () => {
    const res = await createFolder({ data: { account_id: ACC, name: "  Vendors  " } });
    expect(res).toEqual({ id: NEW_FOLDER });

    const inserts = writesTo(fake, "inserts", "folders");
    expect(inserts).toHaveLength(1);
    // A brand-new folder must classify nothing until the user gives it
    // explicit intent — skip_ai true, and no filter tree or ai_rule at all.
    expect(inserts[0]!.payload).toEqual({
      user_id: TEST_USER,
      gmail_account_id: ACC,
      name: "Vendors", // trimmed by the validator
      color: "#3b82f6",
      gmail_label_id: null,
      skip_ai: true,
      min_ai_confidence: 0.75,
    });
  });

  it("carries an explicit colour and a linked Gmail label through unchanged", async () => {
    await createFolder({
      data: { account_id: ACC, name: "Vendors", color: "#ff0000", gmail_label_id: "Label_27" },
    });
    expect(writesTo(fake, "inserts", "folders")[0]!.payload).toEqual({
      user_id: TEST_USER,
      gmail_account_id: ACC,
      name: "Vendors",
      color: "#ff0000",
      gmail_label_id: "Label_27",
      // Linking a label does NOT turn the AI classifier on.
      skip_ai: true,
      min_ai_confidence: 0.75,
    });
  });

  it("surfaces the database's own message when the insert fails", async () => {
    fake.onInsert("folders", () => ({ message: "duplicate key value" }));
    await expect(createFolder({ data: { account_id: ACC, name: "Vendors" } })).rejects.toThrow(
      "duplicate key value",
    );
  });

  it("denies a caller who does not own the account before inserting anything", async () => {
    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(createFolder, "intruder")({ data: { account_id: ACC, name: "Vendors" } }),
      rejects: "Not authorized for this account",
    });
  });
});
