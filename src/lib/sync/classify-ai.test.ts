// Unit tests for the AI layer of classification — classifyByAi and
// applySurfaceRule. The rules layer (classifyByRules / classifyParsedEmail
// routing order) is covered by src/lib/sync-classify.test.ts; these tests
// cover only the gaps around the AI fallback:
//
//   * candidate-set construction (skip_ai folders and veto filters must
//     never be offered to the AI — it can't place mail where hard rules
//     would reject it),
//   * per-folder min_ai_confidence gating and the ai_low_confidence stamp,
//   * an AI-gateway throw becomes ai_error, never an exception,
//   * applySurfaceRule builds the "me" identity (account email + folder
//     aliases) and short-circuits without an AI call when there is no rule.

import { describe, it, expect, beforeEach, vi } from "vitest";

const classifyEmailMock = vi.fn();
const shouldSurfaceToInboxMock = vi.fn();

// Property accesses are deferred into method bodies so the hoisted factory
// never touches the module-level fns before their initializers run.
vi.mock("../ai.server", () => ({
  classifyEmail: (...args: unknown[]) => classifyEmailMock(...args),
  shouldSurfaceToInbox: (...args: unknown[]) => shouldSurfaceToInboxMock(...args),
}));

import { classifyByAi, applySurfaceRule, type ClassificationResult } from "./classify";
import type { AccountContext } from "./account-context";
import type { Filter, Folder } from "./types";

function folder(over: Partial<Folder> = {}): Folder {
  return {
    id: "f-a",
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
    gmail_account_id: "acc-1",
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

function ctx(over: Partial<AccountContext> = {}): AccountContext {
  return {
    folders: over.folders ?? [],
    filters: over.filters ?? [],
    overrides: over.overrides ?? [],
    overrideExceptions: over.overrideExceptions ?? [],
    enrichedFolders:
      over.enrichedFolders ??
      (over.folders ?? []).map((f) => ({ id: f.id, name: f.name, ai_rule: f.ai_rule })),
    calendarGuardEnabled: over.calendarGuardEnabled ?? false,
    calendarContacts: over.calendarContacts ?? new Set<string>(),
    accountEmail: over.accountEmail ?? null,
    senderGroups: over.senderGroups ?? new Map(),
  };
}

function email(over: Partial<Parameters<typeof classifyByAi>[0]> = {}) {
  return {
    from_addr: "sender@example.com",
    from_name: "Sender",
    to_addrs: "me@example.com",
    subject: "Hello",
    snippet: "snip",
    body_text: "body",
    body_html: "",
    has_attachment: false,
    received_at: "2026-07-19T00:00:00.000Z",
    raw_labels: ["INBOX"],
    ...over,
  };
}

function base(over: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    folder_id: null,
    classified_by: "none",
    ai_confidence: 0,
    ai_summary: "",
    classification_reason: null,
    matched_filter_ids: [],
    matched_folder_ids: [],
    ...over,
  };
}

beforeEach(() => {
  classifyEmailMock.mockReset();
  shouldSurfaceToInboxMock.mockReset();
});

describe("classifyByAi — candidate folder set", () => {
  it("returns the base unchanged with zero AI calls when every folder is skip_ai", async () => {
    const context = ctx({ folders: [folder({ skip_ai: true })] });
    const b = base({ classification_reason: "carried through" });
    const out = await classifyByAi(email(), context, b);
    expect(out).toEqual(b);
    expect(out).not.toBe(b); // defensive copy, never the caller's object
    expect(classifyEmailMock).not.toHaveBeenCalled();
  });

  it("excludes folders whose veto filters reject the email from the AI's candidate list", async () => {
    // Folder B carries a not_contains veto that this email violates — the
    // AI must never even see B as an option.
    const vetoFilter: Filter = {
      id: "flt-1",
      folder_id: "f-b",
      field: "subject",
      op: "not_contains",
      value: "Hello",
    };
    const context = ctx({
      folders: [folder({ id: "f-a", name: "A" }), folder({ id: "f-b", name: "B" })],
      filters: [vetoFilter],
    });
    classifyEmailMock.mockResolvedValue({
      folder_id: null,
      confidence: 0,
      summary: "",
      reason: "",
    });
    await classifyByAi(email({ subject: "Hello world" }), context, base());
    expect(classifyEmailMock).toHaveBeenCalledTimes(1);
    const offered = classifyEmailMock.mock.calls[0][1] as Array<{ id: string }>;
    expect(offered.map((f) => f.id)).toEqual(["f-a"]);
  });
});

describe("classifyByAi — confidence gating", () => {
  it("adopts the AI folder when confidence meets the folder's min_ai_confidence", async () => {
    const context = ctx({ folders: [folder({ id: "f-a", min_ai_confidence: 0.5 })] });
    classifyEmailMock.mockResolvedValue({
      folder_id: "f-a",
      confidence: 0.9,
      summary: "a receipt",
      reason: "looks like a receipt",
    });
    const out = await classifyByAi(email(), context, base());
    expect(out).toMatchObject({
      folder_id: "f-a",
      classified_by: "ai",
      ai_confidence: 0.9,
      ai_summary: "a receipt",
      classification_reason: "looks like a receipt",
    });
  });

  it("stamps ai_low_confidence and keeps folder_id null below the threshold", async () => {
    const context = ctx({
      folders: [folder({ id: "f-a", name: "Receipts", min_ai_confidence: 0.5 })],
    });
    classifyEmailMock.mockResolvedValue({
      folder_id: "f-a",
      confidence: 0.3,
      summary: "maybe",
      reason: "unsure",
    });
    const out = await classifyByAi(email(), context, base());
    // The suggestion is recorded but the mail must stay in the Inbox.
    expect(out.folder_id).toBeNull();
    expect(out.classified_by).toBe("ai_low_confidence");
    expect(out.ai_confidence).toBe(0.3);
    expect(out.classification_reason).toBe('AI suggested "Receipts" at 30% < min 50%');
  });

  it("records an AI no-match (folder_id null) as classified_by ai with the reason", async () => {
    const context = ctx({ folders: [folder({ id: "f-a" })] });
    classifyEmailMock.mockResolvedValue({
      folder_id: null,
      confidence: 0.2,
      summary: "s",
      reason: "fits nothing",
    });
    const out = await classifyByAi(email(), context, base());
    expect(out).toMatchObject({
      folder_id: null,
      classified_by: "ai",
      ai_confidence: 0.2,
      ai_summary: "s",
      classification_reason: "fits nothing",
    });
  });

  it("converts an AI-gateway throw into ai_error instead of propagating", async () => {
    const context = ctx({ folders: [folder({ id: "f-a" })] });
    classifyEmailMock.mockRejectedValue(new Error("gateway 502"));
    const out = await classifyByAi(email(), context, base());
    expect(out.classified_by).toBe("ai_error");
    expect(out.classification_reason).toBe("AI classifier failed: gateway 502");
    expect(out.folder_id).toBeNull();
  });
});

describe("applySurfaceRule", () => {
  it("returns surface:false without an AI call when the folder has no (or a blank) rule", async () => {
    const context = ctx({
      folders: [folder({ id: "f-a", surface_ai_rule: "   " })],
      accountEmail: "Me@Example.com",
    });
    expect(await applySurfaceRule(email(), context, "f-a")).toEqual({ surface: false, reason: "" });
    expect(await applySurfaceRule(email(), context, "missing-folder")).toEqual({
      surface: false,
      reason: "",
    });
    expect(shouldSurfaceToInboxMock).not.toHaveBeenCalled();
  });

  it("builds the identity from the lowercased account email plus split/trimmed surface_names", async () => {
    const context = ctx({
      folders: [
        folder({
          id: "f-a",
          name: "Newsletters",
          surface_ai_rule: "  keep personal mail visible  ",
          surface_names: "Serge, S. Chernata;\n Sergio ",
        }),
      ],
      accountEmail: "Me@Example.com",
    });
    shouldSurfaceToInboxMock.mockResolvedValue({ surface: true, reason: "addressed to you" });

    const out = await applySurfaceRule(email(), context, "f-a");
    expect(out).toEqual({ surface: true, reason: "addressed to you" });
    expect(shouldSurfaceToInboxMock).toHaveBeenCalledTimes(1);
    const [payload, opts] = shouldSurfaceToInboxMock.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(payload).toMatchObject({ from_addr: "sender@example.com", subject: "Hello" });
    expect(opts).toEqual({
      folderName: "Newsletters",
      surfaceRule: "keep personal mail visible",
      identityEmails: ["me@example.com"],
      identityNames: ["Serge", "S. Chernata", "Sergio"],
    });
  });
});
