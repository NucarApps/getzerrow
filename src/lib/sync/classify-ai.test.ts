// Unit tests for the AI layer of classification — classifyByAi and
// applySurfaceRule. The deterministic ladder is specified in
// ./decide-folder.test.ts and the seam that calls into here in
// ./classify.test.ts; this file covers only the AI fallback itself:
//
//   * candidate-set construction (skip_ai folders and veto filters must
//     never be offered to the AI — it can't place mail where hard rules
//     would reject it),
//   * per-folder min_ai_confidence gating and the ai_low_confidence stamp,
//   * an AI-gateway throw becomes ai_error, never an exception,
//   * the AI rung recorded on a REAL decision trace (noteAi early-returns
//     when the base has none, so a hand-built base skips it silently),
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
import { decideFolder } from "./decide-folder";
import type { AccountContext } from "./account-context";
import type { Filter, Folder } from "./types";

function folder(over: Partial<Folder> = {}): Folder {
  return {
    id: "f-a",
    name: "Folder A",
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
    const offered = classifyEmailMock.mock.calls[0]![1] as Array<{ id: string }>;
    expect(offered.map((f) => f.id)).toEqual(["f-a"]);
  });

  it("excludes folders without an ai_rule — inert folders never reach the AI classifier", async () => {
    // Folder A has a learned_profile but no ai_rule — the classic Jared
    // "label-linked folder with only a learned profile" shape. AI must
    // treat it as inert.
    const context = ctx({
      folders: [
        folder({ id: "f-a", name: "A", ai_rule: null, learned_profile: "big profile" }),
        folder({ id: "f-b", name: "B", ai_rule: "route work mail here" }),
      ],
    });
    classifyEmailMock.mockResolvedValue({
      folder_id: null,
      confidence: 0,
      summary: "",
      reason: "",
    });
    await classifyByAi(email(), context, base());
    expect(classifyEmailMock).toHaveBeenCalledTimes(1);
    const offered = classifyEmailMock.mock.calls[0]![1] as Array<{ id: string }>;
    expect(offered.map((f) => f.id)).toEqual(["f-b"]);
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

// classifyByAi's noteAi early-returns when `base` carries no trace, so a
// hand-built base() silently skips every trace assertion. These start from a
// REAL decideFolder result — the shape production actually hands in.
describe("classifyByAi — the AI rung on a real decision trace", () => {
  const context = ctx({
    folders: [folder({ id: "f-a", name: "Receipts", min_ai_confidence: 0.5 })],
  });
  /** What the deterministic ladder produces for mail nothing filed. */
  const laddered = () => decideFolder(email(), context, { trigger: "arrival" });

  it("the base really is AI-pending and already carries a trace", () => {
    const b = laddered();
    expect(b.needs_ai).toBe(true);
    expect(b.trace?.version).toBe(1);
    expect(b.trace?.ai).toBeUndefined();
  });

  it("an accepted suggestion records the folder, confidence, threshold and an applied step", async () => {
    classifyEmailMock.mockResolvedValue({
      folder_id: "f-a",
      confidence: 0.9,
      summary: "a receipt",
      reason: "looks like a receipt",
    });
    const out = await classifyByAi(email(), context, laddered());
    expect(out.trace?.ai).toStrictEqual({
      suggested_folder_id: "f-a",
      suggested_folder_name: "Receipts",
      confidence: 0.9,
      threshold: 0.5,
      accepted: true,
    });
    expect(out.trace?.steps.at(-1)).toStrictEqual({
      rung: "ai",
      outcome: "applied",
      detail: 'AI suggested "Receipts" at 90% (needs 50%)',
    });
  });

  it("a below-threshold suggestion records accepted:false and a skipped step", async () => {
    classifyEmailMock.mockResolvedValue({
      folder_id: "f-a",
      confidence: 0.3,
      summary: "maybe",
      reason: "unsure",
    });
    const out = await classifyByAi(email(), context, laddered());
    expect(out.trace?.ai).toMatchObject({ accepted: false, confidence: 0.3, threshold: 0.5 });
    expect(out.trace?.steps.at(-1)).toMatchObject({ rung: "ai", outcome: "skipped" });
  });

  it("an AI no-match records a null suggestion and says so in the step", async () => {
    classifyEmailMock.mockResolvedValue({
      folder_id: null,
      confidence: 0.2,
      summary: "s",
      reason: "fits nothing",
    });
    const out = await classifyByAi(email(), context, laddered());
    expect(out.trace?.ai).toStrictEqual({
      suggested_folder_id: null,
      suggested_folder_name: null,
      confidence: 0.2,
      threshold: 0,
      accepted: false,
    });
    expect(out.trace?.steps.at(-1)).toMatchObject({
      rung: "ai",
      detail: "AI found no matching folder",
    });
  });

  it("a second AI pass REPLACES the rung instead of appending a second one", async () => {
    // withAiStep filters the existing "ai" step out before pushing. A retry
    // (or a re-run over a stored trace) must leave exactly one ai step, or
    // the drawer shows two contradictory AI verdicts for one message.
    classifyEmailMock.mockResolvedValue({
      folder_id: "f-a",
      confidence: 0.3,
      summary: "maybe",
      reason: "unsure",
    });
    const first = await classifyByAi(email(), context, laddered());
    expect(first.trace?.steps.filter((s) => s.rung === "ai")).toHaveLength(1);

    classifyEmailMock.mockResolvedValue({
      folder_id: "f-a",
      confidence: 0.95,
      summary: "a receipt",
      reason: "certain now",
    });
    const second = await classifyByAi(email(), context, first);
    expect(second.trace?.steps.filter((s) => s.rung === "ai")).toHaveLength(1);
    expect(second.trace?.ai).toMatchObject({ confidence: 0.95, accepted: true });
    expect(second.trace?.steps.at(-1)).toMatchObject({ outcome: "applied" });
  });

  it("an AI failure leaves the trace's AI rung unset rather than recording a verdict", async () => {
    classifyEmailMock.mockRejectedValue(new Error("gateway 502"));
    const out = await classifyByAi(email(), context, laddered());
    expect(out.classified_by).toBe("ai_error");
    expect(out.trace?.ai).toBeUndefined();
    expect(out.trace?.steps.some((s) => s.rung === "ai" && s.outcome !== "pass")).toBe(false);
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
