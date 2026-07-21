// Unit tests for rescueStrandedEmails — the last-resort sweep for emails
// whose classification never completed. The contracts that matter:
//
//   * eligibility is plaintext-indexed (folder_id null, non-terminal state,
//     recent, under the attempt cap) — terminal/capped rows never re-enter,
//   * a decrypt failure aborts the whole sweep with ZERO writes,
//   * rows the queue still owns (live message_jobs) are skipped — rescuing
//     them would race the worker,
//   * classify_attempts is bumped up-front so a crash mid-sweep still counts,
//   * rules run before AI (catches folders/filters created after arrival),
//   * batched AI falls back per-message (missing index OR whole-batch throw),
//   * min_ai_confidence gates the batch result exactly like the live path,
//   * exhausting RESCUE_MAX_ATTEMPTS goes terminal as 'unclassified' (visible
//     in Inbox — the correct failure mode), otherwise back to 'pending_ai'.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import type { AccountContext } from "./account-context";
import type { Folder } from "./types";
import { RESCUE_MAX_ATTEMPTS } from "./config";

const fake = makeSupabaseFake();

// Property accesses are deferred into method bodies so the hoisted factory
// never touches `fake` before its initializer runs.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

const getEmailsDecrypted = vi.fn();
vi.mock("./encrypted-reader", () => ({
  getEmailsDecrypted: (ids: string[]) => getEmailsDecrypted(ids),
}));

const updateEmailEncrypted = vi.fn();
vi.mock("./encrypted-writer", () => ({
  updateEmailEncrypted: (input: unknown) => updateEmailEncrypted(input),
}));

const classifyEmail = vi.fn();
const classifyEmailsBatch = vi.fn();
vi.mock("../ai.server", () => ({
  classifyEmail: (...args: unknown[]) => classifyEmail(...args),
  classifyEmailsBatch: (...args: unknown[]) => classifyEmailsBatch(...args),
  // classify.ts (kept real) imports this; the rescue paths never reach it.
  shouldSurfaceToInbox: async () => ({ surface: false, reason: "" }),
}));

const loadAccountContext = vi.fn();
vi.mock("./account-context", () => ({
  loadAccountContext: (accountId: string, userId: string) => loadAccountContext(accountId, userId),
}));

const applyFolderActions = vi.fn();
vi.mock("./process-message", () => ({
  applyFolderActions: (...args: unknown[]) => applyFolderActions(...args),
}));

const bumpEmailsSinceLearn = vi.fn();
vi.mock("./folder-learn", () => ({
  bumpEmailsSinceLearn: (folderId: string) => bumpEmailsSinceLearn(folderId),
}));

import { rescueStrandedEmails } from "./rescue";

const USER = "user-1";
const ACC = "acc-1";

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: "folder-1",
    name: "Receipts",
    gmail_label_id: null,
    ai_rule: "route mail here",
    learned_profile: null,
    last_learned_at: null,
    auto_archive: false,
    auto_mark_read: false,
    auto_star: false,
    hide_from_inbox: false,
    skip_ai: false,
    priority: 0,
    gmail_account_id: ACC,
    filter_logic: "any",
    filter_tree: null,
    forward_to: null,
    min_ai_confidence: 0,
    snooze_hours: 0,
    overrides_inbox_override: false,
    is_cold_email: false,
    surface_ai_rule: null,
    surface_names: null,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<AccountContext> = {}): AccountContext {
  const folders = overrides.folders ?? [];
  return {
    folders,
    filters: [],
    overrides: [],
    overrideExceptions: [],
    enrichedFolders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      ai_rule: f.ai_rule,
      learned_profile: f.learned_profile,
      examples: [],
    })),
    calendarGuardEnabled: false,
    calendarContacts: new Set<string>(),
    accountEmail: "me@x.com",
    senderGroups: new Map<string, Set<string>>(),
    ...overrides,
  };
}

/** Eligible stranded row: no folder, non-terminal state, fresh, under cap. */
function strandedRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: USER,
    gmail_account_id: ACC,
    gmail_message_id: `gm-${id}`,
    from_addr: "sender@x.com",
    list_id: null,
    in_reply_to: null,
    has_attachment: false,
    received_at: "2026-07-19T10:00:00.000Z",
    raw_labels: ["INBOX", "UNREAD"],
    classify_attempts: 0,
    folder_id: null,
    classified_by: "pending_ai",
    created_at: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

function attemptBumps() {
  return fake.calls.updates.filter(
    (u) =>
      u.table === "emails" &&
      typeof (u.payload as Record<string, unknown>).classify_attempts === "number",
  );
}

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  // Decrypt round-trip: every requested id comes back with the sensitive
  // fields the classifier needs.
  getEmailsDecrypted.mockImplementation(async (ids: string[]) => ({
    rows: ids.map((id) => ({
      id,
      from_name: "Sender",
      to_addrs: "me@x.com",
      cc: null,
      subject: `subject-${id}`,
      snippet: "snip",
      body_text: "body",
    })),
    error: null,
  }));
  updateEmailEncrypted.mockResolvedValue({ error: null });
  applyFolderActions.mockResolvedValue(undefined);
  bumpEmailsSinceLearn.mockResolvedValue(undefined);
  loadAccountContext.mockImplementation(async () => makeCtx());
  classifyEmail.mockResolvedValue({ folder_id: null, confidence: 0, summary: "", reason: "" });
  classifyEmailsBatch.mockImplementation(async (emails: unknown[]) =>
    emails.map(() => ({ folder_id: null, confidence: 0, summary: "", reason: "" })),
  );
});

describe("eligibility scan", () => {
  it("ignores rows at the attempt cap or in a terminal state — no decrypt, no writes", async () => {
    fake.seed("emails", [
      strandedRow("e-capped", { classify_attempts: RESCUE_MAX_ATTEMPTS }),
      strandedRow("e-terminal", { classified_by: "ai" }),
      strandedRow("e-filed", { folder_id: "folder-1" }),
    ]);
    const res = await rescueStrandedEmails();
    expect(res).toEqual({ scanned: 0, rescued: 0, failed: 0, skipped: 0 });
    expect(getEmailsDecrypted).not.toHaveBeenCalled();
    expect(fake.calls.updates).toHaveLength(0);
  });

  it("aborts the entire sweep with zero writes when the decrypt RPC fails", async () => {
    fake.seed("emails", [strandedRow("e1"), strandedRow("e2")]);
    getEmailsDecrypted.mockResolvedValueOnce({ rows: [], error: "decrypt down" });
    const res = await rescueStrandedEmails();
    expect(res).toEqual({ scanned: 2, rescued: 0, failed: 0, skipped: 0, error: "decrypt down" });
    // Nothing may have been touched: no attempt bumps, no encrypted writes,
    // no classification calls.
    expect(fake.calls.updates).toHaveLength(0);
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
    expect(loadAccountContext).not.toHaveBeenCalled();
  });
});

describe("live-job skip", () => {
  it("skips rows the queue still owns and returns early when all are owned", async () => {
    fake.seed("emails", [strandedRow("e1")]);
    fake.seed("message_jobs", [
      { gmail_account_id: ACC, gmail_message_id: "gm-e1", status: "pending" },
    ]);
    const res = await rescueStrandedEmails();
    expect(res).toEqual({ scanned: 1, rescued: 0, failed: 0, skipped: 1 });
    // Early return BEFORE the attempt bump — a skipped row keeps its budget.
    expect(attemptBumps()).toHaveLength(0);
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
  });

  it("only rescues rows without a live job; done/dlq jobs do not block", async () => {
    fake.seed("emails", [
      strandedRow("e1", { created_at: new Date(Date.now() - 1_000).toISOString() }),
      strandedRow("e2", { created_at: new Date(Date.now() - 2_000).toISOString() }),
    ]);
    fake.seed("message_jobs", [
      { gmail_account_id: ACC, gmail_message_id: "gm-e1", status: "running" },
      { gmail_account_id: ACC, gmail_message_id: "gm-e2", status: "done" },
    ]);
    // No folders → rules outcome is final (nothing for AI to do).
    const res = await rescueStrandedEmails();
    expect(res).toEqual({ scanned: 2, rescued: 1, failed: 0, skipped: 1 });
    expect(updateEmailEncrypted).toHaveBeenCalledTimes(1);
    expect(updateEmailEncrypted).toHaveBeenCalledWith(expect.objectContaining({ email_id: "e2" }));
  });
});

describe("attempt accounting", () => {
  it("bumps classify_attempts up-front for every eligible row", async () => {
    fake.seed("emails", [strandedRow("e1", { classify_attempts: 1 })]);
    await rescueStrandedEmails();
    const bumps = attemptBumps();
    expect(bumps).toHaveLength(1);
    expect(bumps[0].payload).toEqual({ classify_attempts: 2 });
    expect(bumps[0].filters).toEqual([{ op: "eq", col: "id", value: "e1" }]);
  });
});

describe("rules pass", () => {
  it("finalizes a Gmail-label match without calling AI, applies folder actions, bumps learn counter", async () => {
    const folder = makeFolder({ gmail_label_id: "L-1", auto_archive: true });
    loadAccountContext.mockResolvedValue(makeCtx({ folders: [folder] }));
    fake.seed("emails", [strandedRow("e1", { raw_labels: ["INBOX", "L-1"] })]);

    const res = await rescueStrandedEmails();
    expect(res).toEqual({ scanned: 1, rescued: 1, failed: 0, skipped: 0 });
    expect(classifyEmail).not.toHaveBeenCalled();
    expect(classifyEmailsBatch).not.toHaveBeenCalled();

    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: "e1",
      folder_id: "folder-1",
      ai_summary: null,
      ai_confidence: 1,
      classified_by: "gmail_label",
      classification_reason: 'Already labeled "Receipts" in Gmail at sync time',
      matched_filter_ids: [],
      matched_folder_ids: [],
    });
    expect(bumpEmailsSinceLearn).toHaveBeenCalledWith("folder-1");
    // Folder actions run with persistFlags: true (post-insert stamp) and the
    // inInbox flag derived from raw_labels.
    expect(applyFolderActions).toHaveBeenCalledWith(
      ACC,
      "gm-e1",
      "e1",
      {
        id: "folder-1",
        gmail_label_id: "L-1",
        auto_archive: true,
        auto_mark_read: false,
        auto_star: false,
        hide_from_inbox: false,
        forward_to: null,
        snooze_hours: 0,
      },
      {
        raw_labels: ["INBOX", "L-1"],
        subject: "subject-e1",
        from_addr: "sender@x.com",
        from_name: "Sender",
        received_at: "2026-07-19T10:00:00.000Z",
        body_text: "body",
        snippet: "snip",
      },
      true,
      { persistFlags: true },
    );
  });
});

describe("batched AI pass", () => {
  it("routes a confident batch result into the folder as classified_by=ai", async () => {
    const ctx = makeCtx({ folders: [makeFolder()] });
    loadAccountContext.mockResolvedValue(ctx);
    fake.seed("emails", [strandedRow("e1")]);
    classifyEmailsBatch.mockResolvedValueOnce([
      { folder_id: "folder-1", confidence: 0.92, summary: "sum", reason: "looks like a receipt" },
    ]);

    const res = await rescueStrandedEmails();
    expect(res).toEqual({ scanned: 1, rescued: 1, failed: 0, skipped: 0 });
    expect(classifyEmailsBatch).toHaveBeenCalledTimes(1);
    const [batchEmails, batchFolders] = classifyEmailsBatch.mock.calls[0] as [unknown[], unknown];
    expect(batchEmails).toHaveLength(1);
    expect(batchEmails[0]).toMatchObject({ from_addr: "sender@x.com", subject: "subject-e1" });
    expect(batchFolders).toBe(ctx.enrichedFolders);
    expect(updateEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({
        email_id: "e1",
        folder_id: "folder-1",
        classified_by: "ai",
        ai_confidence: 0.92,
        ai_summary: "sum",
        classification_reason: "looks like a receipt",
      }),
    );
    expect(applyFolderActions).toHaveBeenCalledTimes(1);
  });

  it("gates a below-threshold suggestion to ai_low_confidence with folder_id null", async () => {
    loadAccountContext.mockResolvedValue(
      makeCtx({ folders: [makeFolder({ min_ai_confidence: 0.9 })] }),
    );
    fake.seed("emails", [strandedRow("e1")]);
    classifyEmailsBatch.mockResolvedValueOnce([
      { folder_id: "folder-1", confidence: 0.5, summary: "s", reason: "maybe" },
    ]);

    const res = await rescueStrandedEmails();
    // Still counts as rescued — the row reached a terminal decision.
    expect(res).toEqual({ scanned: 1, rescued: 1, failed: 0, skipped: 0 });
    expect(updateEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({
        email_id: "e1",
        folder_id: null,
        classified_by: "ai_low_confidence",
        ai_confidence: 0.5,
        classification_reason: 'AI suggested "Receipts" at 50% < min 90%',
      }),
    );
    // No folder → no Gmail actions, no learn bump.
    expect(applyFolderActions).not.toHaveBeenCalled();
    expect(bumpEmailsSinceLearn).not.toHaveBeenCalled();
  });

  it("falls back to single classifyEmail for indexes the batch response omitted", async () => {
    loadAccountContext.mockResolvedValue(makeCtx({ folders: [makeFolder()] }));
    fake.seed("emails", [
      strandedRow("e1", { created_at: new Date(Date.now() - 1_000).toISOString() }),
      strandedRow("e2", { created_at: new Date(Date.now() - 2_000).toISOString() }),
    ]);
    // Batch answers only the first message; the second index is undefined.
    classifyEmailsBatch.mockResolvedValueOnce([
      { folder_id: "folder-1", confidence: 1, summary: "s1", reason: "r1" },
    ]);
    classifyEmail.mockResolvedValueOnce({
      folder_id: "folder-1",
      confidence: 0.8,
      summary: "s2",
      reason: "r2",
    });

    const res = await rescueStrandedEmails();
    expect(res).toEqual({ scanned: 2, rescued: 2, failed: 0, skipped: 0 });
    expect(classifyEmail).toHaveBeenCalledTimes(1);
    expect(classifyEmail.mock.calls[0][0]).toMatchObject({ subject: "subject-e2" });
    expect(updateEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({ email_id: "e2", classified_by: "ai", ai_confidence: 0.8 }),
    );
  });

  it("falls back per-message for the whole chunk when the batch call throws", async () => {
    loadAccountContext.mockResolvedValue(makeCtx({ folders: [makeFolder()] }));
    fake.seed("emails", [
      strandedRow("e1", { created_at: new Date(Date.now() - 1_000).toISOString() }),
      strandedRow("e2", { created_at: new Date(Date.now() - 2_000).toISOString() }),
    ]);
    classifyEmailsBatch.mockRejectedValueOnce(new Error("gateway 500"));
    classifyEmail.mockResolvedValue({
      folder_id: "folder-1",
      confidence: 1,
      summary: "s",
      reason: "r",
    });

    const res = await rescueStrandedEmails();
    expect(res).toEqual({ scanned: 2, rescued: 2, failed: 0, skipped: 0 });
    expect(classifyEmail).toHaveBeenCalledTimes(2);
  });
});

describe("failure recording", () => {
  it("stays retryable as pending_ai when under the attempt cap", async () => {
    loadAccountContext.mockResolvedValue(makeCtx({ folders: [makeFolder()] }));
    fake.seed("emails", [strandedRow("e1", { classify_attempts: 0 })]);
    classifyEmailsBatch.mockRejectedValueOnce(new Error("gateway down"));
    classifyEmail.mockRejectedValue(new Error("gateway down"));

    const res = await rescueStrandedEmails();
    expect(res).toEqual({ scanned: 1, rescued: 0, failed: 1, skipped: 0 });
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: "e1",
      classified_by: "pending_ai",
      classification_reason: "Rescue attempt 1 failed (will retry): gateway down",
    });
  });

  it("goes terminal as unclassified once RESCUE_MAX_ATTEMPTS is reached", async () => {
    loadAccountContext.mockResolvedValue(makeCtx({ folders: [makeFolder()] }));
    // One attempt left: this sweep bumps to the cap, so its failure is final.
    fake.seed("emails", [strandedRow("e1", { classify_attempts: RESCUE_MAX_ATTEMPTS - 1 })]);
    classifyEmailsBatch.mockRejectedValueOnce(new Error("gateway down"));
    classifyEmail.mockRejectedValue(new Error("gateway down"));

    const res = await rescueStrandedEmails();
    expect(res).toEqual({ scanned: 1, rescued: 0, failed: 1, skipped: 0 });
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: "e1",
      classified_by: "unclassified",
      classification_reason: `Classification failed after ${RESCUE_MAX_ATTEMPTS} rescue attempts: gateway down`,
    });
  });

  it("counts every row of an account failed when loadAccountContext throws, without touching them", async () => {
    loadAccountContext.mockRejectedValue(new Error("db down"));
    fake.seed("emails", [strandedRow("e1"), strandedRow("e2")]);
    const res = await rescueStrandedEmails();
    expect(res).toEqual({ scanned: 2, rescued: 0, failed: 2, skipped: 0 });
    expect(classifyEmail).not.toHaveBeenCalled();
    expect(classifyEmailsBatch).not.toHaveBeenCalled();
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
  });
});
