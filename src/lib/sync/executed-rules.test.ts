// Rules-engine audit log (executed_rules) — the contracts protected:
//
//   * exactly ONE record_executed_rule RPC per ingested email, for both
//     the rules branch and the AI branch of the classify path,
//   * a rules match records status 'applied' with matched_leaf_json
//     populated from the winning folder's filter_tree (or the matched
//     folder_filters rows when the folder uses simple filters),
//   * an AI match records status 'applied' with the AI confidence,
//   * an exclude-rule veto records status 'skipped' (no folder),
//   * a classify failure records status 'error' with the error message,
//   * the deferred-AI (backfill) lane records status 'pending',
//   * the insert is BEST-EFFORT: an RPC failure is logged and swallowed —
//     it never breaks message processing.
//
// The pipeline mocks mirror process-message.test.ts; the executed-rules
// module itself is real so the RPC payload is asserted end to end.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

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

const logError = vi.fn();
vi.mock("@/lib/log.server", () => ({
  logError: (...args: unknown[]) => logError(...args),
  logInfo: () => {},
  logMetric: () => {},
}));

import { processGmailMessage } from "./process-message";
import { statusForClassification } from "./executed-rules";
import type { AccountContext } from "./account-context";
import type { RulesClassification, ClassificationResult } from "./classify";
import type { Folder, Filter } from "./types";

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
    gmail_label_id: null,
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

function context(folders: Folder[] = [], filters: Filter[] = []): AccountContext {
  return {
    folders,
    filters,
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

function recordCalls() {
  return fake.calls.rpcs.filter((r) => r.fn === "record_executed_rule");
}

const savedKey = process.env.EMAIL_ENC_KEY;

beforeEach(() => {
  fake.reset();
  process.env.EMAIL_ENC_KEY = "test-enc-key";
  getMessage.mockClear();
  parseMessage.mockClear();
  modifyMessage.mockClear();
  modifyMessage.mockResolvedValue({});
  sendMessage.mockClear();
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
  logError.mockClear();
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.EMAIL_ENC_KEY;
  else process.env.EMAIL_ENC_KEY = savedKey;
});

describe("recordExecution via the classify path", () => {
  it("rules match: one 'applied' row with matched_leaf_json from the folder's filter_tree", async () => {
    const folderA = fullFolder({
      filter_tree: { type: "cond", field: "subject", op: "contains", value: "hello" },
    });
    classifyByRules.mockReturnValue(
      rules({
        folder_id: "folder-A",
        classified_by: "filter",
        ai_confidence: 1,
        classification_reason: 'Rule group matched for "Folder A"',
      }),
    );
    const parsed = parsedFixture({ subject: "Hello there" });

    await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsed,
      context: context([folderA]),
    });

    expect(recordCalls()).toHaveLength(1);
    expect(recordCalls()[0].args).toMatchObject({
      p_user_id: USER,
      p_gmail_account_id: ACC,
      p_email_id: "email-1",
      p_gmail_message_id: GMAIL_ID,
      p_folder_id: "folder-A",
      p_classified_by: "filter",
      p_status: "applied",
      p_matched_leaf_json: [{ field: "subject", op: "contains", value: "hello" }],
      p_reason: 'Rule group matched for "Folder A"',
      p_automated: true,
      p_error: null,
      p_key: "test-enc-key",
    });
  });

  it("simple-filter match: matched_leaf_json comes from the matched folder_filters rows", async () => {
    const folderA = fullFolder();
    const filter: Filter = {
      id: "flt-1",
      folder_id: "folder-A",
      field: "from",
      op: "contains",
      value: "sender@x.com",
    };
    classifyByRules.mockReturnValue(
      rules({ folder_id: "folder-A", classified_by: "filter", matched_filter_ids: ["flt-1"] }),
    );

    await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsedFixture(),
      context: context([folderA], [filter]),
    });

    expect(recordCalls()).toHaveLength(1);
    expect(recordCalls()[0].args).toMatchObject({
      p_matched_filter_ids: ["flt-1"],
      p_matched_leaf_json: [{ field: "from", op: "contains", value: "sender@x.com" }],
    });
  });

  it("AI match: one 'applied' row carrying classified_by 'ai' and the confidence", async () => {
    classifyByRules.mockReturnValue(rules({ needs_ai: true }));
    classifyByAi.mockResolvedValue(
      aiResult({ folder_id: "folder-A", ai_confidence: 0.87, classification_reason: "ai says so" }),
    );

    await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsedFixture(),
      context: context([fullFolder()]),
    });

    expect(recordCalls()).toHaveLength(1);
    expect(recordCalls()[0].args).toMatchObject({
      p_folder_id: "folder-A",
      p_classified_by: "ai",
      p_ai_confidence: 0.87,
      p_status: "applied",
      p_reason: "ai says so",
      p_error: null,
    });
  });

  it("exclude veto: one 'skipped' row with no folder and the exclusion reason", async () => {
    classifyByRules.mockReturnValue(
      rules({
        classified_by: "excluded",
        classification_reason: 'Would match "Folder A" but excluded by rule: from not_contains "x"',
      }),
    );

    await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsedFixture(),
      context: context([fullFolder()]),
    });

    expect(recordCalls()).toHaveLength(1);
    expect(recordCalls()[0].args).toMatchObject({
      p_folder_id: null,
      p_classified_by: "excluded",
      p_status: "skipped",
      p_reason: 'Would match "Folder A" but excluded by rule: from not_contains "x"',
    });
  });

  it("classify failure: one 'error' row with the error message", async () => {
    classifyByRules.mockReturnValue(rules({ needs_ai: true }));
    classifyByAi.mockRejectedValue(new Error("ai gateway down"));

    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsedFixture(),
      context: context([fullFolder()]),
    });

    expect(res).toEqual({ id: "email-1", classify_failed: true });
    expect(recordCalls()).toHaveLength(1);
    expect(recordCalls()[0].args).toMatchObject({
      p_classified_by: "unclassified",
      p_status: "error",
      p_error: "ai gateway down",
      p_reason: "Classification failed: ai gateway down",
    });
  });

  it("deferred-AI (backfill) lane: one 'pending' row", async () => {
    classifyByRules.mockReturnValue(rules({ needs_ai: true }));

    await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsedFixture(),
      context: context([fullFolder()]),
      skipAi: true,
    });

    expect(classifyByAi).not.toHaveBeenCalled();
    expect(recordCalls()).toHaveLength(1);
    expect(recordCalls()[0].args).toMatchObject({
      p_classified_by: "pending_ai",
      p_status: "pending",
      p_folder_id: null,
    });
  });

  it("is best-effort: an RPC failure is logged and never breaks processing", async () => {
    fake.onRpc("record_executed_rule", () => ({ error: { message: "db down" } }));
    classifyByRules.mockReturnValue(rules({ folder_id: "folder-A", classified_by: "filter" }));

    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsedFixture(),
      context: context([fullFolder()]),
    });

    expect(res).toMatchObject({ id: "email-1", folder_id: "folder-A" });
    expect(logError).toHaveBeenCalledWith(
      "executed_rules.record_failed",
      expect.objectContaining({ classified_by: "filter", status: "applied" }),
      expect.anything(),
    );
  });

  it("stuck-pending retry records the completed classification", async () => {
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
        classified_by: "pending_ai",
        folder_id: null,
      },
    ]);
    classifyByRules.mockReturnValue(rules({ needs_ai: true }));
    classifyByAi.mockResolvedValue(aiResult({ folder_id: "folder-A" }));

    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: parsedFixture(),
      context: context([fullFolder()]),
    });

    expect(res).toMatchObject({ id: "row-1", reclassified: true });
    expect(recordCalls()).toHaveLength(1);
    expect(recordCalls()[0].args).toMatchObject({
      p_email_id: "row-1",
      p_classified_by: "ai",
      p_status: "applied",
    });
  });
});

describe("statusForClassification", () => {
  it.each([
    ["filter", "applied"],
    ["domain_rule", "applied"],
    ["gmail_label", "applied"],
    ["ai", "applied"],
    ["inbox_override", "applied"],
    ["surfaced_to_inbox", "applied"],
    ["none", "applied"],
    ["excluded", "skipped"],
    ["ai_low_confidence", "skipped"],
    ["calendar_contact", "skipped"],
    ["ai_error", "error"],
    ["unclassified", "error"],
  ] as const)("%s → %s", (classified_by, expected) => {
    expect(statusForClassification(aiResult({ classified_by }))).toBe(expected);
  });
});
