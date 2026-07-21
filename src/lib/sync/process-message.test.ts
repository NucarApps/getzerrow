// Unit tests for processGmailMessage / applyFolderActions — the single-
// message ingest pipeline. The classification layers themselves are covered
// elsewhere (sync-classify.test.ts, classify-ai.test.ts); here classifyByRules
// / classifyByAi are mocked so each pipeline branch can be forced. The
// contracts protected:
//
//   * repair fills missing encrypted metadata instead of re-inserting,
//   * terminal rows are skipped; stuck pending/pending_ai rows re-classify,
//   * SENT/DRAFT/TRASH/SPAM/CHAT never insert,
//   * rules-final mail lands with its final is_archived / is_read flags in
//     the single INSERT (no flash through the Inbox), hide_from_inbox
//     behaving exactly like auto_archive,
//   * the mobile push fires only for fresh, non-archived, non-backfill mail,
//   * an AI failure stamps 'unclassified' — the email is never stranded,
//   * applyFolderActions: Gmail failures are swallowed, forwards schedule a
//     retry on failure, empty patches write nothing, STARRED only when absent.

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

const getMessage = vi.fn(async (..._args: unknown[]) => ({ id: "raw" }));
const parseMessage = vi.fn((_raw: unknown) => parsedFixture());
const modifyMessage = vi.fn(async (..._args: unknown[]) => ({}));
const sendMessage = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../gmail.server", () => ({
  getMessage: (...args: unknown[]) => getMessage(...args),
  parseMessage: (raw: unknown) => parseMessage(raw),
  modifyMessage: (...args: unknown[]) => modifyMessage(...args),
  sendMessage: (...args: unknown[]) => sendMessage(...args),
}));

const classifyByRules = vi.fn();
const classifyByAi = vi.fn();
const applySurfaceRule = vi.fn(async (..._args: unknown[]) => ({ surface: false, reason: "" }));
vi.mock("./classify", () => ({
  classifyByRules: (...args: unknown[]) => classifyByRules(...args),
  classifyByAi: (...args: unknown[]) => classifyByAi(...args),
  applySurfaceRule: (...args: unknown[]) => applySurfaceRule(...args),
}));

const upsertEmailEncrypted = vi.fn(
  async (_input: unknown) =>
    ({ id: "email-1", error: null }) as { id: string | null; error: string | null },
);
const updateEmailEncrypted = vi.fn(async (_input: unknown) => ({ error: null as string | null }));
vi.mock("./encrypted-writer", () => ({
  upsertEmailEncrypted: (input: unknown) => upsertEmailEncrypted(input),
  updateEmailEncrypted: (input: unknown) => updateEmailEncrypted(input),
}));

const bumpEmailsSinceLearn = vi.fn(async (_folderId: string) => {});
vi.mock("./folder-learn", () => ({
  bumpEmailsSinceLearn: (folderId: string) => bumpEmailsSinceLearn(folderId),
}));

const notifyInboxMail = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../push.server", () => ({
  notifyInboxMail: (...args: unknown[]) => notifyInboxMail(...args),
}));

const loadAccountContext = vi.fn(async (..._args: unknown[]) => context());
vi.mock("./account-context", () => ({
  loadAccountContext: (...args: unknown[]) => loadAccountContext(...args),
}));

import { applyFolderActions, processGmailMessage, type ActionFolder } from "./process-message";
import type { AccountContext } from "./account-context";
import type { RulesClassification, ClassificationResult } from "./classify";
import type { Folder } from "./types";

const ACC = "acc-1";
const GMAIL_ID = "gm-1";
const USER = "user-1";

type GmailServer = typeof import("../gmail.server");
type Parsed = ReturnType<GmailServer["parseMessage"]>;

function parsedFixture(over: Partial<Parsed> = {}): Parsed {
  return {
    gmail_message_id: GMAIL_ID,
    thread_id: "t-1",
    from_addr: "sender@x.com",
    from_name: "Sender",
    to_addrs: "me@x.com",
    cc: "",
    list_id: "",
    in_reply_to: "",
    subject: "Hello",
    snippet: "snip",
    body_text: "body",
    body_html: "",
    received_at: new Date().toISOString(),
    has_attachment: false,
    has_calendar_invite: false,
    raw_labels: ["INBOX", "UNREAD"],
    is_read: false,
    ...over,
  };
}

function fullFolder(over: Partial<Folder> = {}): Folder {
  return {
    id: "folder-A",
    name: "Folder A",
    gmail_label_id: "L-A",
    ai_rule: null,
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
    ...over,
  };
}

function context(folders: Folder[] = []): AccountContext {
  return {
    folders,
    filters: [],
    overrides: [],
    overrideExceptions: [],
    enrichedFolders: folders.map((f) => ({ id: f.id, name: f.name, ai_rule: f.ai_rule })),
    calendarGuardEnabled: false,
    calendarContacts: new Set(),
    accountEmail: "me@x.com",
    senderGroups: new Map(),
  };
}

function rules(over: Partial<RulesClassification> = {}): RulesClassification {
  return {
    folder_id: null,
    classified_by: "none",
    ai_confidence: 0,
    ai_summary: "",
    classification_reason: null,
    matched_filter_ids: [],
    matched_folder_ids: [],
    needs_ai: false,
    needs_surface_check: false,
    ...over,
  };
}

function aiResult(over: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    folder_id: null,
    classified_by: "ai",
    ai_confidence: 0.9,
    ai_summary: "sum",
    classification_reason: "reason",
    matched_filter_ids: [],
    matched_folder_ids: [],
    ...over,
  };
}

function seedExistingEmail(over: Record<string, unknown> = {}) {
  fake.seed("emails", [
    {
      id: "row-1",
      gmail_message_id: GMAIL_ID,
      gmail_account_id: ACC,
      from_addr: "sender@x.com",
      subject_enc: "enc",
      body_text_enc: "enc",
      body_html_enc: null,
      received_at: "2026-07-18T00:00:00.000Z",
      classified_by: "ai",
      folder_id: "folder-A",
      ...over,
    },
  ]);
}

function emailUpdates() {
  return fake.calls.updates.filter((u) => u.table === "emails");
}

beforeEach(() => {
  fake.reset();
  getMessage.mockClear();
  parseMessage.mockClear();
  modifyMessage.mockClear();
  modifyMessage.mockResolvedValue({});
  sendMessage.mockClear();
  sendMessage.mockResolvedValue({});
  classifyByRules.mockReset();
  classifyByAi.mockReset();
  applySurfaceRule.mockClear();
  applySurfaceRule.mockResolvedValue({ surface: false, reason: "" });
  upsertEmailEncrypted.mockClear();
  upsertEmailEncrypted.mockResolvedValue({ id: "email-1", error: null });
  updateEmailEncrypted.mockClear();
  updateEmailEncrypted.mockResolvedValue({ error: null });
  bumpEmailsSinceLearn.mockClear();
  notifyInboxMail.mockClear();
  loadAccountContext.mockClear();
});

describe("existing-row paths", () => {
  it("repairs a row missing subject_enc via the encrypted writer + plain base-column update", async () => {
    seedExistingEmail({ subject_enc: null });
    const parsed = parsedFixture();
    const res = await processGmailMessage(ACC, GMAIL_ID, USER, { prefetched: parsed });

    expect(res).toEqual({ repaired: true });
    // Sensitive fields go through the encrypted-write RPC…
    expect(updateEmailEncrypted).toHaveBeenCalledTimes(1);
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: "row-1",
      from_name: parsed.from_name,
      to_addrs: parsed.to_addrs,
      subject: parsed.subject,
      snippet: parsed.snippet,
      body_text: parsed.body_text,
      body_html: parsed.body_html,
    });
    // …and the plaintext base columns update directly.
    expect(emailUpdates()).toHaveLength(1);
    expect(emailUpdates()[0].payload).toEqual({
      from_addr: parsed.from_addr,
      received_at: parsed.received_at,
      has_attachment: parsed.has_attachment,
      raw_labels: parsed.raw_labels,
      is_read: parsed.is_read,
    });
    // A repair never re-classifies or re-inserts.
    expect(classifyByRules).not.toHaveBeenCalled();
    expect(upsertEmailEncrypted).not.toHaveBeenCalled();
  });

  it("skips a healthy terminal row (and fetches from Gmail when no prefetched message)", async () => {
    seedExistingEmail();
    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {});
    expect(res).toEqual({ skipped: true });
    expect(getMessage).toHaveBeenCalledWith(ACC, GMAIL_ID);
    expect(parseMessage).toHaveBeenCalledTimes(1);
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
    expect(upsertEmailEncrypted).not.toHaveBeenCalled();
    expect(emailUpdates()).toHaveLength(0);
  });

  it("stuck pending + skipAi leaves the row pending and signals needs_ai to the caller", async () => {
    seedExistingEmail({ classified_by: "pending_ai", folder_id: null });
    classifyByRules.mockReturnValue(rules({ needs_ai: true }));
    const parsed = parsedFixture();
    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsed,
      context: context(),
      skipAi: true,
    });
    expect(res).toEqual({
      id: "row-1",
      email_id: "row-1",
      folder_id: null,
      parsed,
      needs_ai: true,
    });
    expect(classifyByAi).not.toHaveBeenCalled();
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
  });

  it("stuck pending re-runs AI, applies folder actions with persistFlags, and persists", async () => {
    seedExistingEmail({ classified_by: "pending", folder_id: null });
    const folderA = fullFolder({ auto_archive: true, gmail_label_id: "L-A" });
    classifyByRules.mockReturnValue(rules({ needs_ai: true }));
    classifyByAi.mockResolvedValue(aiResult({ folder_id: "folder-A" }));
    const parsed = parsedFixture();

    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsed,
      context: context([folderA]),
    });

    expect(res).toEqual({
      id: "row-1",
      email_id: "row-1",
      folder_id: "folder-A",
      parsed,
      reclassified: true,
    });
    // persistFlags=true: the archive flag is patched onto the existing row.
    expect(modifyMessage).toHaveBeenCalledWith(ACC, GMAIL_ID, ["L-A"], ["INBOX"]);
    expect(emailUpdates()).toHaveLength(1);
    expect(emailUpdates()[0].payload).toEqual({ is_archived: true });
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: "row-1",
      folder_id: "folder-A",
      ai_summary: "sum",
      ai_confidence: 0.9,
      classified_by: "ai",
      classification_reason: "reason",
      matched_filter_ids: [],
      matched_folder_ids: [],
    });
    expect(bumpEmailsSinceLearn).toHaveBeenCalledWith("folder-A");
  });

  it("stuck pending rules-final with a surface rule reverses the hide and stamps surfaced_to_inbox", async () => {
    seedExistingEmail({ classified_by: "pending", folder_id: null });
    const folderA = fullFolder({ hide_from_inbox: true, gmail_label_id: null });
    classifyByRules.mockReturnValue(
      rules({ folder_id: "folder-A", classified_by: "filter", needs_surface_check: true }),
    );
    applySurfaceRule.mockResolvedValue({ surface: true, reason: "personal" });
    const parsed = parsedFixture({ raw_labels: ["INBOX"] });

    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsed,
      context: context([folderA]),
    });

    expect(res).toMatchObject({ folder_id: "folder-A", reclassified: true });
    // First modify hides it (hide_from_inbox ≡ archive), second re-adds INBOX.
    expect(modifyMessage).toHaveBeenNthCalledWith(1, ACC, GMAIL_ID, [], ["INBOX"]);
    expect(modifyMessage).toHaveBeenNthCalledWith(2, ACC, GMAIL_ID, ["INBOX"], []);
    const surfacedPatch = emailUpdates().find((u) => "surfaced_to_inbox" in (u.payload as object));
    expect(surfacedPatch?.payload).toEqual({
      is_archived: false,
      surfaced_to_inbox: true,
      snoozed_until: null,
    });
    expect(updateEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({
        email_id: "row-1",
        classified_by: "surfaced_to_inbox",
        classification_reason: "Surfaced to inbox: personal",
      }),
    );
    expect(bumpEmailsSinceLearn).toHaveBeenCalledWith("folder-A");
  });
});

describe("excluded labels", () => {
  it.each(["SENT", "DRAFT", "TRASH", "SPAM", "CHAT"])(
    "never inserts a %s message",
    async (label) => {
      const parsed = parsedFixture({ raw_labels: [label] });
      const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
        prefetched: parsed,
        context: context(),
      });
      expect(res).toEqual({ skipped: true });
      expect(upsertEmailEncrypted).not.toHaveBeenCalled();
      expect(classifyByRules).not.toHaveBeenCalled();
    },
  );
});

describe("new-message insert paths", () => {
  it("rules-final insert carries final is_archived/is_read in the single INSERT (no inbox flash)", async () => {
    const folderA = fullFolder({ auto_archive: true, auto_mark_read: true });
    classifyByRules.mockReturnValue(rules({ folder_id: "folder-A", classified_by: "filter" }));
    const parsed = parsedFixture();

    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsed,
      context: context([folderA]),
    });

    expect(res).toMatchObject({ id: "email-1", folder_id: "folder-A", needs_ai: false });
    expect(upsertEmailEncrypted).toHaveBeenCalledTimes(1);
    expect(upsertEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({
        is_archived: true, // effectiveArchive folds into the insert itself
        is_read: true, // auto_mark_read folds in too
        classified_by: "filter",
      }),
    );
    // Gmail side-effects still run, but with persistFlags=false: no second
    // flag patch on the emails row (the INSERT already carried the flags).
    expect(modifyMessage).toHaveBeenCalledWith(ACC, GMAIL_ID, ["L-A"], ["UNREAD", "INBOX"]);
    expect(emailUpdates()).toHaveLength(0);
    // Auto-archived mail never triggers a mobile push.
    expect(notifyInboxMail).not.toHaveBeenCalled();
    expect(bumpEmailsSinceLearn).toHaveBeenCalledWith("folder-A");
  });

  it("hide_from_inbox behaves exactly like auto_archive for the inserted flags", async () => {
    const folderA = fullFolder({ hide_from_inbox: true, auto_archive: false });
    classifyByRules.mockReturnValue(rules({ folder_id: "folder-A", classified_by: "filter" }));
    await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsedFixture(),
      context: context([folderA]),
    });
    expect(upsertEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({ is_archived: true }),
    );
    expect(notifyInboxMail).not.toHaveBeenCalled();
  });

  it("persists the folder's snooze onto the fresh rules-final row", async () => {
    const folderA = fullFolder({ snooze_hours: 2, gmail_label_id: null });
    classifyByRules.mockReturnValue(rules({ folder_id: "folder-A", classified_by: "filter" }));
    const before = Date.now();
    await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsedFixture(),
      context: context([folderA]),
    });
    const snoozeUpdate = emailUpdates().find((u) => "snoozed_until" in (u.payload as object));
    expect(snoozeUpdate).toBeDefined();
    const until = Date.parse((snoozeUpdate!.payload as { snoozed_until: string }).snoozed_until);
    expect(until).toBeGreaterThanOrEqual(before + 2 * 3600_000 - 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + 2 * 3600_000 + 1000);
  });

  it("runs the surface check for a rules-final folder with a surface rule", async () => {
    const folderA = fullFolder({ gmail_label_id: null });
    const ctx = context([folderA]);
    classifyByRules.mockReturnValue(
      rules({ folder_id: "folder-A", classified_by: "filter", needs_surface_check: true }),
    );
    const parsed = parsedFixture();
    await processGmailMessage(ACC, GMAIL_ID, USER, { prefetched: parsed, context: ctx });
    expect(applySurfaceRule).toHaveBeenCalledWith(parsed, ctx, "folder-A");
    // surface=false → filed as usual, no reversal patch.
    expect(
      emailUpdates().find((u) => "surfaced_to_inbox" in (u.payload as object)),
    ).toBeUndefined();
  });

  it("needs-AI mail inserts as pending_ai, then the AI pass persists the outcome", async () => {
    classifyByRules.mockReturnValue(
      rules({ needs_ai: true, classification_reason: "override bypassed by exception" }),
    );
    classifyByAi.mockResolvedValue(aiResult({ folder_id: null }));
    const parsed = parsedFixture();

    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsed,
      context: context([fullFolder()]),
    });

    expect(res).toEqual({
      id: "email-1",
      email_id: "email-1",
      folder_id: null,
      parsed,
      needs_ai: false,
    });
    // Visible in the Inbox immediately: not archived, awaiting AI.
    expect(upsertEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({ classified_by: "pending_ai", is_archived: false }),
    );
    // The rules' provisional reason is stamped before the AI pass…
    expect(updateEmailEncrypted).toHaveBeenNthCalledWith(1, {
      email_id: "email-1",
      classification_reason: "override bypassed by exception",
    });
    // …and the AI outcome is persisted afterwards.
    expect(updateEmailEncrypted).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ email_id: "email-1", classified_by: "ai" }),
    );
  });

  it("skipAi defers the AI pass to the caller's batched lane", async () => {
    classifyByRules.mockReturnValue(rules({ needs_ai: true }));
    const parsed = parsedFixture();
    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsed,
      context: context([fullFolder()]),
      skipAi: true,
    });
    expect(res).toEqual({
      id: "email-1",
      email_id: "email-1",
      folder_id: null,
      parsed,
      needs_ai: true,
    });
    expect(classifyByAi).not.toHaveBeenCalled();
  });

  it("aborts when the insert RPC errors — no push, no AI, no follow-up writes", async () => {
    classifyByRules.mockReturnValue(rules({ needs_ai: true }));
    upsertEmailEncrypted.mockResolvedValue({ id: null, error: "insert down" });
    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsedFixture(),
      context: context([fullFolder()]),
    });
    expect(res).toEqual({ error: "insert down" });
    expect(notifyInboxMail).not.toHaveBeenCalled();
    expect(classifyByAi).not.toHaveBeenCalled();
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
  });

  it("a classifyByAi throw stamps 'unclassified' so the email is never stranded", async () => {
    classifyByRules.mockReturnValue(rules({ needs_ai: true }));
    classifyByAi.mockRejectedValue(new Error("ai gateway down"));
    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsedFixture(),
      context: context([fullFolder()]),
    });
    expect(res).toEqual({ id: "email-1", classify_failed: true });
    expect(updateEmailEncrypted).toHaveBeenLastCalledWith({
      email_id: "email-1",
      classified_by: "unclassified",
      classification_reason: "Classification failed: ai gateway down",
    });
  });
});

describe("push-notification gating", () => {
  it("notifies for fresh, non-archived inbox mail", async () => {
    classifyByRules.mockReturnValue(rules());
    const parsed = parsedFixture({ received_at: new Date().toISOString() });
    await processGmailMessage(ACC, GMAIL_ID, USER, { prefetched: parsed, context: context() });
    expect(notifyInboxMail).toHaveBeenCalledTimes(1);
    expect(notifyInboxMail).toHaveBeenCalledWith(USER, {
      from_name: parsed.from_name,
      from_addr: parsed.from_addr,
      subject: parsed.subject,
    });
  });

  it("suppresses the push for skipPush (backfill) callers", async () => {
    classifyByRules.mockReturnValue(rules());
    await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsedFixture(),
      context: context(),
      skipPush: true,
    });
    expect(notifyInboxMail).not.toHaveBeenCalled();
  });

  it("suppresses the push for mail older than the freshness window", async () => {
    classifyByRules.mockReturnValue(rules());
    const stale = new Date(Date.now() - 2 * 3600_000).toISOString();
    await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsedFixture({ received_at: stale }),
      context: context(),
    });
    expect(notifyInboxMail).not.toHaveBeenCalled();
  });
});

describe("applyFolderActions (direct)", () => {
  const actionFolder = (over: Partial<ActionFolder> = {}): ActionFolder => ({
    id: "folder-A",
    gmail_label_id: null,
    auto_archive: false,
    auto_mark_read: false,
    auto_star: false,
    hide_from_inbox: false,
    forward_to: null,
    snooze_hours: 0,
    ...over,
  });
  const actionParsed = (over: Partial<Parsed> = {}) => {
    const p = parsedFixture(over);
    return {
      raw_labels: p.raw_labels,
      subject: p.subject,
      from_addr: p.from_addr,
      from_name: p.from_name,
      received_at: p.received_at,
      body_text: p.body_text,
      snippet: p.snippet,
    };
  };

  it("forwards successfully and clears prior retry state in the same patch", async () => {
    const parsed = actionParsed();
    await applyFolderActions(
      ACC,
      GMAIL_ID,
      "row-1",
      actionFolder({ forward_to: "fwd@x.com" }),
      parsed,
      true,
      { persistFlags: false },
    );
    expect(sendMessage).toHaveBeenCalledWith(
      ACC,
      "fwd@x.com",
      "Fwd: Hello",
      expect.stringContaining("---------- Forwarded message ----------"),
    );
    expect(emailUpdates()).toHaveLength(1);
    expect(emailUpdates()[0].payload).toMatchObject({
      forwarded_to: "fwd@x.com",
      forward_attempts: 0,
      forward_last_error: null,
      forward_next_retry_at: null,
    });
  });

  it("a failed forward schedules a jittered retry instead of dropping silently", async () => {
    sendMessage.mockRejectedValue(new Error("smtp down"));
    const before = Date.now();
    await applyFolderActions(
      ACC,
      GMAIL_ID,
      "row-1",
      actionFolder({ forward_to: "fwd@x.com" }),
      actionParsed(),
      true,
      { persistFlags: false },
    );
    expect(emailUpdates()).toHaveLength(1);
    const patch = emailUpdates()[0].payload as Record<string, unknown>;
    expect(patch).toMatchObject({ forward_attempts: 1, forward_last_error: "smtp down" });
    const retryAt = Date.parse(patch.forward_next_retry_at as string);
    // jitter(60) → 45–75s from now.
    expect(retryAt).toBeGreaterThanOrEqual(before + 45_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 75_000 + 1000);
  });

  it("swallows a modifyMessage throw — the local flag patch still lands", async () => {
    modifyMessage.mockRejectedValue(new Error("gmail 500"));
    await applyFolderActions(
      ACC,
      GMAIL_ID,
      "row-1",
      actionFolder({ auto_archive: true, gmail_label_id: "L-A" }),
      actionParsed(),
      true,
      { persistFlags: true },
    );
    expect(emailUpdates()).toHaveLength(1);
    expect(emailUpdates()[0].payload).toEqual({ is_archived: true });
  });

  it("writes nothing at all when there is no label change, no flags, and no forward", async () => {
    // Label already present, no auto flags: an empty patch must not touch
    // Gmail or the emails row.
    await applyFolderActions(
      ACC,
      GMAIL_ID,
      "row-1",
      actionFolder({ gmail_label_id: "L-A" }),
      actionParsed({ raw_labels: ["INBOX", "L-A"] }),
      true,
      { persistFlags: false },
    );
    expect(modifyMessage).not.toHaveBeenCalled();
    expect(emailUpdates()).toHaveLength(0);
  });

  it("adds STARRED only when the message does not already carry it", async () => {
    await applyFolderActions(
      ACC,
      GMAIL_ID,
      "row-1",
      actionFolder({ auto_star: true }),
      actionParsed({ raw_labels: ["INBOX", "STARRED"] }),
      true,
      { persistFlags: false },
    );
    expect(modifyMessage).not.toHaveBeenCalled();

    await applyFolderActions(
      ACC,
      GMAIL_ID,
      "row-1",
      actionFolder({ auto_star: true }),
      actionParsed({ raw_labels: ["INBOX"] }),
      true,
      { persistFlags: false },
    );
    expect(modifyMessage).toHaveBeenCalledWith(ACC, GMAIL_ID, ["STARRED"], []);
  });
});
