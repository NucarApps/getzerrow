// The AI classifier's CASCADE mechanics, and the two smaller AI helpers the
// folder editor depends on.
//
// Prompt hardening and sanitization for the same functions live in
// sync/classify.security.test.ts; what is pinned here is the control flow
// around the model call, which is what decides whether an email gets
// classified at all:
//
//   * escalation — a structured attempt that fails must fall through to the
//     lenient text attempt on the SAME model before a slower model is tried,
//     and the lenient parse has to survive a model that wraps its JSON in
//     prose (the reason the text attempt exists at all);
//   * name resolution — the model answers with a folder NAME, and a name
//     that matches nothing (a hallucinated folder, or "NONE") must resolve
//     to "no folder", never to whichever folder happened to be first;
//   * the wall-clock budget — AI_CLASSIFY_TOTAL_BUDGET_MS is shared across
//     the whole cascade, so each attempt's timeout shrinks as the budget is
//     spent and the cascade stops rather than overrunning it. A classifier
//     that overruns its budget stalls the queue worker behind it.
//
// The `ai` SDK and the gateway are mocked (no network); ai-untrusted stays
// REAL so the lenient parse and the confidence capping are the production
// ones. ai-budget's raceTimeout is mocked to a recorder so the per-attempt
// timeout the cascade computes can be asserted directly.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const generateText = vi.fn();
vi.mock("ai", () => ({
  generateText: (args: unknown) => generateText(args),
  Output: { object: (o: unknown) => o },
}));

vi.mock("./ai-gateway", () => ({
  createLovableAiGatewayProvider: () => (modelId: string) => ({ modelId }),
  getModel: (modelId: string = "google/gemini-2.5-flash") => ({ modelId }),
  getGateway: () => (modelId: string) => ({ modelId }),
  describeError: (e: unknown) => (e as Error)?.message ?? "unknown error",
}));

/** Every raceTimeout the cascade set up, in order. */
const races: Array<{ ms: number; label: string }> = [];
vi.mock("./ai-budget", () => ({
  remainingAttemptTimeout: (deadline: number, attemptMs: number, now = Date.now()) =>
    deadline - now < 500 ? null : Math.min(attemptMs, deadline - now),
  raceTimeout: <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
    races.push({ ms, label });
    return p;
  },
}));

import { buildFolderProfile, classifyEmail, suggestFolderFromEmails } from "./ai.server";
import { AI_CLASSIFY_ATTEMPT_TIMEOUT_MS, AI_CLASSIFY_TOTAL_BUDGET_MS } from "./sync/config";

const FOLDERS = [
  { id: "f-news", name: "Newsletters", ai_rule: "Bulk newsletters and digests" },
  { id: "f-priority", name: "Priority", ai_rule: "Urgent mail from real people" },
];

function email(over: Partial<Parameters<typeof classifyEmail>[0]> = {}) {
  return {
    from_addr: "sender@example.com",
    from_name: "Sender",
    subject: "Weekly digest",
    snippet: "This week in tech",
    body_text: "A perfectly ordinary newsletter body.",
    ...over,
  };
}

/** The arguments of the nth generateText call. */
function callArgs(n: number): { model: { modelId: string }; prompt: string; output?: unknown } {
  return generateText.mock.calls[n]![0] as {
    model: { modelId: string };
    prompt: string;
    output?: unknown;
  };
}

const modelsTried = () => generateText.mock.calls.map((_c, i) => callArgs(i).model.modelId);

beforeEach(() => {
  generateText.mockReset();
  races.length = 0;
  vi.stubEnv("LOVABLE_API_KEY", "test-key");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("classifyEmail — the model call itself", () => {
  it("never calls a model when the user has no folders to classify into", async () => {
    const res = await classifyEmail(email(), []);
    expect(res).toEqual({ folder_id: null, confidence: 0, summary: "", reason: "" });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("resolves the model's folder NAME to its id, ignoring case", async () => {
    generateText.mockResolvedValue({
      output: { folder_name: "newsletters", confidence: 0.82, summary: "Digest", reason: "Bulk" },
    });

    const res = await classifyEmail(email(), FOLDERS);
    expect(res).toEqual({
      folder_id: "f-news",
      confidence: 0.82,
      summary: "Digest",
      reason: "Bulk",
    });
    // One attempt: the fastest model, structured, and nothing after it.
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(callArgs(0).model.modelId).toBe("google/gemini-2.5-flash-lite");
    expect(callArgs(0).output).toBeDefined();
  });

  it("treats a folder name the user does not have as no folder at all", async () => {
    generateText.mockResolvedValue({
      output: {
        folder_name: "Receipts", // hallucinated — not one of FOLDERS
        confidence: 0.95,
        summary: "Digest",
        reason: "Looks like a receipt",
      },
    });

    const res = await classifyEmail(email(), FOLDERS);
    // The email stays unfiled rather than landing in an arbitrary folder,
    // and the model's own confidence/reason are still reported so the
    // caller can log why nothing matched.
    expect(res).toEqual({
      folder_id: null,
      confidence: 0.95,
      summary: "Digest",
      reason: "Looks like a receipt",
    });
  });

  it("maps the explicit NONE answer to no folder", async () => {
    generateText.mockResolvedValue({
      output: { folder_name: "NONE", confidence: 0.3, summary: "s", reason: "nothing fits" },
    });
    const res = await classifyEmail(email(), FOLDERS);
    expect(res.folder_id).toBeNull();
  });

  it("falls through to the lenient text attempt on the same model, and parses JSON out of prose", async () => {
    generateText
      .mockRejectedValueOnce(new Error("structured output unsupported"))
      .mockResolvedValueOnce({
        // A model that ignores "no prose, no code fences" — the whole reason
        // the text attempt uses the lenient parser instead of JSON.parse.
        text: `Sure! Here's my classification:

\`\`\`json
{"folder_name":"Newsletters","confidence":0.66,"summary":"Weekly digest","reason":"Bulk sender"}
\`\`\`

Let me know if you'd like a different folder.`,
      });

    const res = await classifyEmail(email(), FOLDERS);
    expect(res).toEqual({
      folder_id: "f-news",
      confidence: 0.66,
      summary: "Weekly digest",
      reason: "Bulk sender",
    });

    // The retry stays on the SAME (fastest) model before escalating.
    expect(modelsTried()).toEqual(["google/gemini-2.5-flash-lite", "google/gemini-2.5-flash-lite"]);
    // …and it drops structured output in favour of an explicit JSON contract
    // in the prompt.
    expect(callArgs(1).output).toBeUndefined();
    expect(callArgs(1).prompt).toContain("Respond with ONLY a JSON object");
    expect(callArgs(1).prompt).toContain('"Newsletters", "Priority"');
  });

  it("keeps escalating when the text attempt returns something unparseable", async () => {
    generateText
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ text: "I'm sorry, I can't help with that." })
      .mockResolvedValueOnce({
        output: { folder_name: "Priority", confidence: 0.5, summary: "s", reason: "r" },
      });

    const res = await classifyEmail(email(), FOLDERS);
    expect(res.folder_id).toBe("f-priority");
    // Only after both attempts on the fast model does the slower one run.
    expect(modelsTried()).toEqual([
      "google/gemini-2.5-flash-lite",
      "google/gemini-2.5-flash-lite",
      "google/gemini-2.5-flash",
    ]);
  });

  it("throws — never guesses a folder — once every model in the cascade has failed", async () => {
    generateText.mockRejectedValue(new Error("gateway 502"));

    await expect(classifyEmail(email(), FOLDERS)).rejects.toThrow(
      "AI classifier returned no parseable response (last error: gateway 502)",
    );
    // The full six-step cascade ran: two attempts each on the two Gemini
    // models, then the two OpenAI fallbacks.
    expect(modelsTried()).toEqual([
      "google/gemini-2.5-flash-lite",
      "google/gemini-2.5-flash-lite",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-flash",
      "openai/gpt-5-mini",
      "openai/gpt-5-nano",
    ]);
  });

  it("shrinks each attempt's timeout as the shared budget is spent, and stops when it runs out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T10:00:00.000Z"));
    // Every attempt burns 8s of wall clock before failing. The advance is
    // deferred past the first microtask so it lands while the call is in
    // flight, the way real latency does.
    generateText.mockImplementation(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(8_000);
      throw new Error("upstream stalled");
    });

    await expect(classifyEmail(email(), FOLDERS)).rejects.toThrow(
      "AI classifier returned no parseable response",
    );

    // First two attempts are capped by the per-attempt timeout; by the third
    // only 2s of the 18s total budget is left, so the attempt is cut to it.
    expect(races.map((r) => r.ms)).toEqual([
      AI_CLASSIFY_ATTEMPT_TIMEOUT_MS,
      AI_CLASSIFY_ATTEMPT_TIMEOUT_MS,
      AI_CLASSIFY_TOTAL_BUDGET_MS - 2 * 8_000,
    ]);
    // The remaining three cascade steps are abandoned rather than started
    // past the deadline.
    expect(generateText).toHaveBeenCalledTimes(3);
    expect(races.map((r) => r.label)).toEqual([
      "classify structured (google/gemini-2.5-flash-lite)",
      "classify text-json (google/gemini-2.5-flash-lite)",
      "classify structured (google/gemini-2.5-flash)",
    ]);
  });
});

describe("buildFolderProfile", () => {
  it("returns an empty profile without calling a model when the folder has no examples", async () => {
    const res = await buildFolderProfile("Newsletters", "Bulk mail", []);
    expect(res).toBe("");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("describes the folder from its examples, trimming the model's answer", async () => {
    generateText.mockResolvedValue({ text: "  Weekly product digests from SaaS vendors.\n" });

    const res = await buildFolderProfile("Newsletters", "Bulk newsletters", [
      { from_addr: "news@acme.test", subject: "Acme Weekly", snippet: "This week at Acme" },
    ]);
    expect(res).toBe("Weekly product digests from SaaS vendors.");

    const prompt = callArgs(0).prompt;
    expect(prompt).toContain('the folder "Newsletters"');
    expect(prompt).toContain("User's stated rule: Bulk newsletters");
    expect(prompt).toContain(
      "1. From: news@acme.test | Subject: Acme Weekly | Snippet: This week at Acme",
    );
  });

  it("omits the rule line when the folder has none, and caps the example list at 50", async () => {
    generateText.mockResolvedValue({ text: "profile" });

    await buildFolderProfile(
      "Newsletters",
      null,
      Array.from({ length: 60 }, (_, i) => ({
        from_addr: `s${i}@acme.test`,
        subject: `Subject ${i}`,
        snippet: null,
      })),
    );

    const prompt = callArgs(0).prompt;
    expect(prompt).not.toContain("User's stated rule");
    expect(prompt).toContain("50. From: s49@acme.test");
    expect(prompt).not.toContain("51. From: s50@acme.test");
  });
});

describe("suggestFolderFromEmails", () => {
  const SELECTION = [
    {
      from_addr: "billing@acme.test",
      from_name: "Acme Billing",
      subject: "Invoice 1042",
      snippet: "Your invoice is ready",
    },
  ];

  it("returns the model's proposed folder shape as-is", async () => {
    const proposal = {
      name: "Invoices",
      color: "#f59e0b",
      ai_rule: "Vendor invoices and billing receipts.",
      filter_field: "domain" as const,
      filter_op: "equals" as const,
      filter_value: "acme.test",
      why: "Every selected email is a vendor invoice.",
    };
    generateText.mockResolvedValue({ output: proposal });

    const res = await suggestFolderFromEmails(SELECTION);
    expect(res).toEqual(proposal);
    // The palette the schema constrains `color` to is spelled out in the
    // prompt, so the model is choosing from the same list the UI renders.
    expect(callArgs(0).prompt).toContain("#f59e0b, #10b981, #3b82f6");
    expect(callArgs(0).prompt).toContain(
      "1. From: Acme Billing <billing@acme.test>\n   Subject: Invoice 1042",
    );
  });

  it("degrades to a generic, filter-free suggestion instead of throwing when the model fails", async () => {
    generateText.mockRejectedValue(new Error("gateway 502"));

    const res = await suggestFolderFromEmails(SELECTION);
    // The drawer stays usable: a named folder the user can rename, and NO
    // concrete filter — guessing one from a failed call would file mail on
    // a rule nothing derived.
    expect(res).toEqual({
      name: "New folder",
      color: "#f59e0b",
      ai_rule: "Emails similar to the selected examples.",
      filter_field: null,
      filter_op: null,
      filter_value: "",
      why: "AI unavailable — using a generic suggestion.",
    });
  });

  it("shows the model at most 30 of the selected emails", async () => {
    generateText.mockResolvedValue({ output: { name: "X" } });

    await suggestFolderFromEmails(
      Array.from({ length: 40 }, (_, i) => ({
        from_addr: `s${i}@acme.test`,
        from_name: null,
        subject: `Subject ${i}`,
        snippet: null,
      })),
    );

    const prompt = callArgs(0).prompt;
    expect(prompt).toContain("30. From:  <s29@acme.test>");
    expect(prompt).not.toContain("31. From:  <s30@acme.test>");
  });
});
