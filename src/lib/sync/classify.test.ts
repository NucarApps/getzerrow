// classifyParsedEmail — the ASYNC half of the routing decision.
//
// The deterministic ladder is decide-folder.ts and is specified rung by
// rung in decide-folder.test.ts; classifyByAi/applySurfaceRule are
// specified in classify-ai.test.ts. What is left, and what this file owns,
// is the seam between them (classify.ts:162-206):
//
//   * loading the account context when the caller did not supply one,
//   * handing off to the AI pass when the ladder reported needs_ai,
//   * running the surface-to-inbox pass when the ladder reported
//     needs_surface_check, and stamping "surfaced_to_inbox" plus a surface
//     trace step when the AI says keep it visible,
//   * skipAi suppressing BOTH of those.
//
// None of it was covered before: every test in the old sync-classify.test.ts
// passed skipAi:true, which is precisely the flag that turns this module off.
import { describe, it, expect, beforeEach, vi } from "vitest";

// The engine stage reads RULES_ENGINE_V2 at call time. Pin it: without
// this the result of these tests depends on the developer's shell.
vi.stubEnv("RULES_ENGINE_V2", "off");

const classifyEmailMock = vi.fn();
const shouldSurfaceToInboxMock = vi.fn();
vi.mock("../ai.server", () => ({
  classifyEmail: (...args: unknown[]) => classifyEmailMock(...args),
  shouldSurfaceToInbox: (...args: unknown[]) => shouldSurfaceToInboxMock(...args),
}));

const loadAccountContextMock = vi.fn();
vi.mock("./account-context", () => ({
  loadAccountContext: (...args: unknown[]) => loadAccountContextMock(...args),
}));

import { classifyParsedEmail } from "./classify";
import { makeAccountContext } from "./__fixtures__/account-context";
import { makeEmailRow, makeFolder, makeRule } from "@/lib/__fixtures__/email-row";

const email = makeEmailRow;
const ctx = makeAccountContext;

/** A folder the AI may consider, with nothing that files by rule. */
const aiFolder = makeFolder({ id: "f-ai", name: "Work", ai_rule: "work mail" });

/** A folder that files by rule and then asks whether to stay visible. */
const surfacing = makeFolder({
  id: "f-news",
  name: "Newsletters",
  ai_rule: null,
  surface_ai_rule: "keep mail addressed to me personally",
});
const surfacingRule = makeRule("f-news", "domain", "contains", "news.test");

beforeEach(() => {
  classifyEmailMock.mockReset();
  shouldSurfaceToInboxMock.mockReset();
  loadAccountContextMock.mockReset();
});

describe("account context", () => {
  it("loads the context for the account when the caller does not supply one", async () => {
    loadAccountContextMock.mockResolvedValue(ctx({ folders: [] }));
    const r = await classifyParsedEmail(email(), "user-1", "acc-1", { skipAi: true });
    expect(loadAccountContextMock).toHaveBeenCalledWith("acc-1", "user-1");
    expect(r.classified_by).toBe("none");
  });

  it("uses a supplied context verbatim and never touches the loader", async () => {
    await classifyParsedEmail(email(), "user-1", "acc-1", {
      context: ctx({ folders: [] }),
      skipAi: true,
    });
    expect(loadAccountContextMock).not.toHaveBeenCalled();
  });
});

describe("AI hand-off", () => {
  it("calls the AI with the ladder's eligible folders when nothing filed the mail", async () => {
    classifyEmailMock.mockResolvedValue({
      folder_id: "f-ai",
      confidence: 0.9,
      summary: "work thread",
      reason: "reads like work",
    });
    const r = await classifyParsedEmail(
      email({ from_addr: "stranger@nowhere.test" }),
      "user-1",
      "acc-1",
      { context: ctx({ folders: [aiFolder] }) },
    );
    expect(classifyEmailMock).toHaveBeenCalledTimes(1);
    expect((classifyEmailMock.mock.calls[0]![1] as Array<{ id: string }>).map((f) => f.id)).toEqual(
      ["f-ai"],
    );
    expect(r).toMatchObject({
      folder_id: "f-ai",
      classified_by: "ai",
      ai_confidence: 0.9,
      ai_summary: "work thread",
      classification_reason: "reads like work",
    });
  });

  it("records the AI rung on the trace the ladder already built", async () => {
    classifyEmailMock.mockResolvedValue({
      folder_id: "f-ai",
      confidence: 0.9,
      summary: "s",
      reason: "r",
    });
    const r = await classifyParsedEmail(
      email({ from_addr: "stranger@nowhere.test" }),
      "user-1",
      "acc-1",
      { context: ctx({ folders: [aiFolder] }) },
    );
    expect(r.trace?.ai).toStrictEqual({
      suggested_folder_id: "f-ai",
      suggested_folder_name: "Work",
      confidence: 0.9,
      threshold: 0,
      accepted: true,
    });
  });

  it("skipAi suppresses the hand-off and leaves the provisional rules answer", async () => {
    const r = await classifyParsedEmail(
      email({ from_addr: "stranger@nowhere.test" }),
      "user-1",
      "acc-1",
      { context: ctx({ folders: [aiFolder] }), skipAi: true },
    );
    expect(classifyEmailMock).not.toHaveBeenCalled();
    expect(r.folder_id).toBeNull();
    expect(r.classified_by).toBe("none");
    // The ladder DID want AI — its trace still records the pending rung.
    expect(r.trace?.steps.at(-1)).toMatchObject({ rung: "ai", outcome: "pass" });
  });

  it("does not call the AI when a rule already filed the mail", async () => {
    const filed = makeFolder({ id: "f-work", name: "Work", ai_rule: "work mail" });
    const r = await classifyParsedEmail(email({ from_addr: "boss@acme.test" }), "user-1", "acc-1", {
      context: ctx({
        folders: [filed],
        filters: [makeRule("f-work", "domain", "contains", "acme.test")],
      }),
    });
    expect(classifyEmailMock).not.toHaveBeenCalled();
    expect(r.folder_id).toBe("f-work");
    expect(r.classified_by).toBe("domain_rule");
  });
});

describe("surface-to-inbox pass", () => {
  const arriving = () => email({ from_addr: "digest@news.test" });
  const surfaceCtx = () =>
    ctx({ folders: [surfacing], filters: [surfacingRule], accountEmail: "me@example.com" });

  it("keeps the message visible and re-stamps the provenance when the AI says surface", async () => {
    shouldSurfaceToInboxMock.mockResolvedValue({ surface: true, reason: "addressed to you" });
    const r = await classifyParsedEmail(arriving(), "user-1", "acc-1", { context: surfaceCtx() });
    expect(shouldSurfaceToInboxMock).toHaveBeenCalledTimes(1);
    // Still FILED into the folder — surfacing only changes visibility.
    expect(r.folder_id).toBe("f-news");
    expect(r.classified_by).toBe("surfaced_to_inbox");
    expect(r.classification_reason).toBe("Surfaced to inbox: addressed to you");
    expect(r.trace?.steps.at(-1)).toStrictEqual({
      rung: "surface",
      outcome: "applied",
      detail: "addressed to you",
    });
  });

  it("falls back to a generic reason when the AI gives none", async () => {
    shouldSurfaceToInboxMock.mockResolvedValue({ surface: true, reason: "" });
    const r = await classifyParsedEmail(arriving(), "user-1", "acc-1", { context: surfaceCtx() });
    expect(r.classification_reason).toBe("Surfaced to inbox by folder rule");
    expect(r.trace?.steps.at(-1)).toMatchObject({
      rung: "surface",
      detail: "Kept visible in your inbox by the folder's surface rule",
    });
  });

  it("leaves the rules answer alone but records the rung when the AI says no", async () => {
    shouldSurfaceToInboxMock.mockResolvedValue({ surface: false, reason: "bulk mail" });
    const r = await classifyParsedEmail(arriving(), "user-1", "acc-1", { context: surfaceCtx() });
    expect(r.folder_id).toBe("f-news");
    expect(r.classified_by).toBe("domain_rule");
    expect(r.trace?.steps.at(-1)).toStrictEqual({
      rung: "surface",
      outcome: "pass",
      detail: "Surface rule did not apply",
    });
  });

  it("skipAi suppresses the surface pass entirely", async () => {
    const r = await classifyParsedEmail(arriving(), "user-1", "acc-1", {
      context: surfaceCtx(),
      skipAi: true,
    });
    expect(shouldSurfaceToInboxMock).not.toHaveBeenCalled();
    expect(r.folder_id).toBe("f-news");
    expect(r.classified_by).toBe("domain_rule");
    expect(r.trace?.steps.some((s) => s.rung === "surface")).toBe(false);
  });

  it("does not run for a folder without a surface rule", async () => {
    const plain = makeFolder({ id: "f-news", name: "Newsletters", ai_rule: null });
    const r = await classifyParsedEmail(arriving(), "user-1", "acc-1", {
      context: ctx({ folders: [plain], filters: [surfacingRule] }),
    });
    expect(shouldSurfaceToInboxMock).not.toHaveBeenCalled();
    expect(r.folder_id).toBe("f-news");
    expect(r.trace?.steps.some((s) => s.rung === "surface")).toBe(false);
  });
});

describe("option pass-through", () => {
  it("skipGmailLabelMatch reaches the ladder, so a labelled message re-derives from rules", async () => {
    const labeled = makeFolder({
      id: "f-label",
      name: "Labeled",
      gmail_label_id: "Label_42",
      ai_rule: null,
    });
    const byRule = makeFolder({ id: "f-rule", name: "Rule", ai_rule: null });
    const context = ctx({
      folders: [labeled, byRule],
      filters: [makeRule("f-rule", "from", "contains", "sender@example.com")],
    });
    const parsed = () => email({ raw_labels: ["INBOX", "Label_42"] });

    const mirrored = await classifyParsedEmail(parsed(), "user-1", "acc-1", {
      context,
      skipAi: true,
    });
    expect(mirrored.folder_id).toBe("f-label");

    const rederived = await classifyParsedEmail(parsed(), "user-1", "acc-1", {
      context,
      skipAi: true,
      skipGmailLabelMatch: true,
    });
    expect(rederived.folder_id).toBe("f-rule");
  });

  it("threadEmails reach the ladder, so a run_on_threads folder can match on a prior message", async () => {
    const threaded = makeFolder({
      id: "f-thread",
      name: "Thread",
      ai_rule: null,
      run_on_threads: true,
    });
    const context = ctx({
      folders: [threaded],
      filters: [makeRule("f-thread", "subject", "contains", "contract")],
    });
    const incoming = () => email({ subject: "Re: following up" });

    const alone = await classifyParsedEmail(incoming(), "user-1", "acc-1", {
      context,
      skipAi: true,
    });
    expect(alone.folder_id).toBeNull();

    const withThread = await classifyParsedEmail(incoming(), "user-1", "acc-1", {
      context,
      skipAi: true,
      threadEmails: [makeEmailRow({ subject: "The contract draft" })],
    });
    expect(withThread.folder_id).toBe("f-thread");
    expect(withThread.classification_reason).toContain("earlier message in this thread");
  });
});
