// The shared Lovable AI Gateway tool-calling client. Contracts protected:
//
//   * model output is UNTRUSTED — tool-call arguments go through
//     JSON.parse → per-action strict-Zod validation (invalid actions are
//     DROPPED, never passed through) → a final capped proposal schema, so
//     a hostile/hallucinated payload can never smuggle an unvalidated
//     action to a caller,
//   * normalizeAction runs before validation (coercions land pre-parse),
//   * a no-tool plain-text answer degrades to reply/clarifying_question,
//   * proposeWithRetry retries ONCE with the stronger reminder only for
//     schema/parse/no-tool failures, and never throws — 402 and 429 map
//     to their user-facing fallback questions.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { callToolModel, proposeWithRetry, gatewayTextCompletion } from "./lovable-gateway.server";

const ACTION = z.object({ kind: z.literal("rename"), value: z.string().min(1) });

const fetchMock = vi.fn<typeof fetch>();

function toolCallResponse(args: unknown, opts: { stringify?: boolean } = {}) {
  const argsStr = opts.stringify === false ? (args as string) : JSON.stringify(args);
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { tool_calls: [{ function: { name: "propose_changes", arguments: argsStr } }] },
        },
      ],
    }),
    { status: 200 },
  );
}

function textResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function baseOpts() {
  return {
    prompt: "do the thing",
    toolDescription: "propose changes",
    toolParametersSchema: { type: "object" },
    actionSchema: ACTION,
  };
}

beforeEach(() => {
  vi.stubEnv("LOVABLE_API_KEY", "test-key");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("callToolModel", () => {
  it("throws before any network call when LOVABLE_API_KEY is missing", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "");
    await expect(callToolModel(baseOpts())).rejects.toThrow("LOVABLE_API_KEY missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends forced tool_choice and the Bearer key to the gateway", async () => {
    fetchMock.mockResolvedValueOnce(toolCallResponse({ reply: "ok", actions: [] }));
    await callToolModel(baseOpts());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("ai.gateway.lovable.dev");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(init!.body));
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "propose_changes" } });
    expect(body.tools[0].function.name).toBe("propose_changes");
  });

  it("drops actions that fail the strict schema and keeps the valid ones", async () => {
    fetchMock.mockResolvedValueOnce(
      toolCallResponse({
        reply: "done",
        actions: [
          { kind: "rename", value: "good" },
          { kind: "rename", value: "" }, // fails min(1)
          { kind: "delete_everything" }, // unknown kind
          "not-an-object",
        ],
      }),
    );
    const out = await callToolModel(baseOpts());
    expect(out.actions).toEqual([{ kind: "rename", value: "good" }]);
    expect(out.reply).toBe("done");
  });

  it("runs normalizeAction before validation", async () => {
    fetchMock.mockResolvedValueOnce(
      toolCallResponse({ actions: [{ kind: "rename", value: "  padded  " }] }),
    );
    const out = await callToolModel({
      ...baseOpts(),
      normalizeAction: (a) => {
        const obj = a as { value?: string };
        if (typeof obj.value === "string") obj.value = obj.value.trim();
      },
    });
    expect(out.actions).toEqual([{ kind: "rename", value: "padded" }]);
  });

  it("non-string reply/clarifying_question are coerced to empty, never passed through", async () => {
    fetchMock.mockResolvedValueOnce(
      toolCallResponse({ reply: { evil: true }, clarifying_question: 42, actions: [] }),
    );
    const out = await callToolModel(baseOpts());
    expect(out).toEqual({ reply: "", clarifying_question: "", actions: [] });
  });

  it("invalid JSON in tool arguments throws a parse error", async () => {
    fetchMock.mockResolvedValueOnce(toolCallResponse("{not json", { stringify: false }));
    await expect(callToolModel(baseOpts())).rejects.toThrow(
      "Tool call arguments were not valid JSON",
    );
  });

  it("a no-tool text answer becomes reply, or clarifying_question when it ends with ?", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("Here is what I found."));
    await expect(callToolModel(baseOpts())).resolves.toEqual({
      reply: "Here is what I found.",
      clarifying_question: "",
      actions: [],
    });
    fetchMock.mockResolvedValueOnce(textResponse("Which folder did you mean? "));
    await expect(callToolModel(baseOpts())).resolves.toEqual({
      reply: "",
      clarifying_question: "Which folder did you mean?",
      actions: [],
    });
  });

  it("empty choice with no tool call throws 'did not call'", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(""));
    await expect(callToolModel(baseOpts())).rejects.toThrow("Model did not call propose_changes");
  });

  it("non-OK gateway response surfaces status and a bounded body excerpt", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(1000), { status: 500 }));
    const err = (await callToolModel(baseOpts()).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("gateway 500");
    expect(err.message.length).toBeLessThan(400);
  });
});

describe("proposeWithRetry", () => {
  const retryOpts = () => ({
    label: "test-feature",
    toolDescription: "propose changes",
    toolParametersSchema: { type: "object" },
    actionSchema: ACTION,
    buildPrompt: (extra?: string) => `PROMPT${extra ? ` :: ${extra}` : ""}`,
  });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("retries once with the stronger reminder on a no-tool failure, and succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse("")) // "did not call" → retry-eligible
      .mockResolvedValueOnce(toolCallResponse({ reply: "second try", actions: [] }));
    const out = await proposeWithRetry(retryOpts());
    expect(out.reply).toBe("second try");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
    expect(secondBody.messages[0].content).toContain("Respond ONLY by calling");
  });

  it("a failed retry degrades to the rephrase question — never throws", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("")).mockResolvedValueOnce(textResponse(""));
    const out = await proposeWithRetry(retryOpts());
    expect(out.actions).toEqual([]);
    expect(out.clarifying_question).toContain("could you rephrase");
  });

  it("402 maps to the credits question without a retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response("payment required", { status: 402 }));
    const out = await proposeWithRetry(retryOpts());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.clarifying_question).toContain("credits");
  });

  it("429 maps to the try-again question without a retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response("slow down", { status: 429 }));
    const out = await proposeWithRetry(retryOpts());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.clarifying_question).toContain("Too many requests");
  });
});

describe("gatewayTextCompletion", () => {
  it("returns the trimmed reply", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("  hello  "));
    await expect(gatewayTextCompletion("hi")).resolves.toBe("hello");
  });

  it("returns null on missing key, non-OK, empty content, and transport error", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "");
    await expect(gatewayTextCompletion("hi")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("LOVABLE_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(gatewayTextCompletion("hi")).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(textResponse(""));
    await expect(gatewayTextCompletion("hi")).resolves.toBeNull();

    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    await expect(gatewayTextCompletion("hi")).resolves.toBeNull();
  });
});
