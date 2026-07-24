// Shared client for the Lovable AI Gateway (OpenAI-style function calling).
// Both the inbox assistant (ai-assistant.server) and the per-folder chat
// (folder-chat.server) ask a model to emit a { reply, clarifying_question,
// actions[] } proposal via a single "propose_changes" tool, with identical
// response parsing, loose-then-strict action validation, and retry/error
// handling. This module owns all of that so the two features can't drift; each
// feature supplies only its own prompt, tool JSON-schema, and action Zod schema.
//
// We call the Gateway directly rather than via the AI SDK's tool() abstraction
// because Gemini handles flat JSON-schema objects reliably but chokes on Zod
// discriminated unions translated to JSON Schema.
import { z } from "zod";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-3-flash-preview";

type ToolCall = { function?: { name?: string; arguments?: string } };
type GatewayChoice = { message?: { content?: string | null; tool_calls?: ToolCall[] } };
type GatewayResponse = { choices?: GatewayChoice[] };

/** The uniform proposal shape every gateway feature returns. */
export type GatewayProposal<A> = {
  reply: string;
  clarifying_question: string;
  actions: A[];
};

function proposalSchemaFor<A>(actionSchema: z.ZodType<A>) {
  return z.object({
    reply: z.string().max(800).optional().default(""),
    clarifying_question: z.string().max(300).optional().default(""),
    actions: z.array(actionSchema).max(20).optional().default([]),
  });
}

const RETRY_REMINDER =
  "Respond ONLY by calling the propose_changes tool with valid JSON arguments. Do not write any prose outside the tool call.";

export type CallToolModelOptions<A> = {
  prompt: string;
  /** Description surfaced on the propose_changes tool. */
  toolDescription: string;
  /** Flat JSON Schema for the tool's parameters (Gemini-friendly). */
  toolParametersSchema: object;
  /** Strict per-action Zod schema; actions that fail it are dropped. */
  actionSchema: z.ZodType<A>;
  /** Optional in-place normalization applied to each raw action before
   * validation (e.g. coercing an empty forward_to to null). */
  normalizeAction?: (action: unknown) => void;
};

/** One call to the gateway with forced propose_changes tool use. Validates
 * each returned action loosely then drops the invalid ones, and falls back to
 * a plain-text reply/clarifying-question when the model answers without the
 * tool. Throws on transport/gateway/parse failures so callers can retry. */
export async function callToolModel<A>(opts: CallToolModelOptions<A>): Promise<GatewayProposal<A>> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");

  const resp = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content: opts.prompt }],
      tools: [
        {
          type: "function",
          function: {
            name: "propose_changes",
            description: opts.toolDescription,
            parameters: opts.toolParametersSchema,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "propose_changes" } },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`gateway ${resp.status}: ${text.slice(0, 300)}`);
  }

  const json = (await resp.json()) as GatewayResponse;
  const choice = json.choices?.[0]?.message;
  const toolCall = choice?.tool_calls?.[0];
  const argsStr = toolCall?.function?.arguments;

  if (argsStr) {
    let raw: unknown;
    try {
      raw = JSON.parse(argsStr);
    } catch {
      throw new Error("Tool call arguments were not valid JSON");
    }
    // Validate loosely first, then drop any action that fails the strict schema.
    const rawObj = (raw ?? {}) as {
      reply?: unknown;
      clarifying_question?: unknown;
      actions?: unknown;
    };
    const rawActions = Array.isArray(rawObj.actions) ? rawObj.actions : [];
    const validActions: A[] = [];
    for (const a of rawActions) {
      if (opts.normalizeAction) opts.normalizeAction(a);
      const parsed = opts.actionSchema.safeParse(a);
      if (parsed.success) validActions.push(parsed.data);
    }
    const final = proposalSchemaFor(opts.actionSchema).safeParse({
      reply: typeof rawObj.reply === "string" ? rawObj.reply : "",
      clarifying_question:
        typeof rawObj.clarifying_question === "string" ? rawObj.clarifying_question : "",
      actions: validActions,
    });
    if (!final.success) throw new Error("Proposal failed final validation");
    return final.data as GatewayProposal<A>;
  }

  // No tool call — surface the plain-text reply if any.
  const text = (choice?.content ?? "").trim();
  if (text) {
    const looksLikeQuestion = /\?\s*$/.test(text);
    return {
      reply: looksLikeQuestion ? "" : text,
      clarifying_question: looksLikeQuestion ? text : "",
      actions: [],
    };
  }
  throw new Error("Model did not call propose_changes");
}

export type ProposeWithRetryOptions<A> = Omit<CallToolModelOptions<A>, "prompt"> & {
  /** Label used in console.error diagnostics for the two failure points. */
  label: string;
  /** Builds the prompt; called again with a stronger reminder on retry. */
  buildPrompt: (extraReminder?: string) => string;
};

/** Wraps callToolModel with the shared behavior both features use: one retry
 * with a stronger reminder on schema/no-object failures, and user-facing
 * fallback questions for credit (402) and rate-limit (429) errors. Never
 * throws — always returns a proposal (possibly empty). */
export async function proposeWithRetry<A>(
  opts: ProposeWithRetryOptions<A>,
): Promise<GatewayProposal<A>> {
  const { label, buildPrompt, ...callOpts } = opts;
  try {
    return await callToolModel({ ...callOpts, prompt: buildPrompt() });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${label} first attempt failed`, msg);
    // One retry with a stronger reminder for schema/no-object failures.
    if (/schema|no object|did not call|parse/i.test(msg)) {
      try {
        return await callToolModel({ ...callOpts, prompt: buildPrompt(RETRY_REMINDER) });
      } catch (err2: unknown) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        console.error(`${label} retry failed`, msg2);
        return {
          reply: "",
          clarifying_question:
            "I had trouble understanding that — could you rephrase what you'd like me to do?",
          actions: [],
        };
      }
    }
    let question = "Sorry, I couldn't reach the AI right now. Please try again in a moment.";
    if (/402|payment|credits?/i.test(msg)) {
      question =
        "AI credits are exhausted for this workspace. Add credits in Settings → Workspace → Usage and try again.";
    } else if (/429|rate/i.test(msg)) {
      question = "Too many requests right now — please try again in a moment.";
    }
    return { reply: "", clarifying_question: question, actions: [] };
  }
}

/** Plain (no-tool) chat completion. Returns the trimmed reply, or null on a
 * missing key, non-OK response, or transport error (callers keep their own
 * fallback). */
export async function gatewayTextCompletion(prompt: string): Promise<string | null> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as GatewayResponse;
    return (json.choices?.[0]?.message?.content ?? "").trim() || null;
  } catch (err: unknown) {
    console.error("gatewayTextCompletion failed", err instanceof Error ? err.message : String(err));
    return null;
  }
}
