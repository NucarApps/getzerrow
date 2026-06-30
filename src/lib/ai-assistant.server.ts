// Server-only helper that asks Lovable AI to translate a user's chat
// instruction into a structured proposal of folder/filter changes. The
// model never writes to the DB — it just emits actions for the user to
// approve in the assistant panel.
//
// We call the Lovable AI Gateway directly (OpenAI-style function calling)
// rather than going through the AI SDK's tool() abstraction, because
// Gemini handles flat JSON-schema objects reliably but chokes on Zod
// discriminated unions translated to JSON Schema.
import { z } from "zod";
import type { DomainCluster } from "./ai-assistant-context";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-3-flash-preview";

const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("move_email"),
    email_id: z.string(),
    to_folder_id: z.string(),
    why: z.string().max(200).optional().default(""),
  }),
  z.object({
    type: z.literal("add_filter"),
    folder_id: z.string(),
    field: z.enum(["from", "domain", "subject"]),
    op: z.enum(["contains", "equals", "starts_with"]),
    value: z.string().min(1).max(400),
    why: z.string().max(200).optional().default(""),
  }),
  z.object({
    type: z.literal("remove_filter"),
    filter_id: z.string(),
    why: z.string().max(200).optional().default(""),
  }),
  z.object({
    type: z.literal("update_folder_rule"),
    folder_id: z.string(),
    ai_rule: z.string().min(1).max(500),
    why: z.string().max(200).optional().default(""),
  }),
  // Bulk move every existing email matching a signal into a folder. Usually
  // paired with add_filter so future mail follows the same rule.
  z.object({
    type: z.literal("move_matching"),
    field: z.enum(["from", "domain", "subject"]),
    op: z.enum(["contains", "equals", "starts_with"]),
    value: z.string().min(1).max(400),
    to_folder_id: z.string(),
    why: z.string().max(200).optional().default(""),
  }),
  // Rewrite the longer learned profile that steers the classifier.
  z.object({
    type: z.literal("update_folder_profile"),
    folder_id: z.string(),
    learned_profile: z.string().min(1).max(2000),
    why: z.string().max(200).optional().default(""),
  }),
]);

export type AssistantAction = z.infer<typeof actionSchema>;

const proposalSchema = z.object({
  reply: z.string().max(800).optional().default(""),
  clarifying_question: z.string().max(300).optional().default(""),
  actions: z.array(actionSchema).max(20).optional().default([]),
});

export type AssistantProposal = {
  reply: string;
  clarifying_question: string;
  actions: AssistantAction[];
};

export type AssistantContextEmail = {
  id: string;
  from_addr: string | null;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  folder_id: string | null;
  domain: string | null;
  is_reply: boolean;
  list_id: string | null;
  classification_reason: string | null;
};

export type AssistantContextFolder = {
  id: string;
  name: string;
  ai_rule: string | null;
  learned_profile: string | null;
  filters: Array<{ id: string; field: string; op: string; value: string }>;
};

export type AssistantChatMessage = { role: "user" | "assistant"; content: string };

function describeContextEmail(e: AssistantContextEmail): string {
  const flags: string[] = [];
  if (e.is_reply) flags.push("reply");
  if (e.list_id) flags.push("mailing-list");
  const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
  const reason = e.classification_reason ? ` | why: ${e.classification_reason.slice(0, 120)}` : "";
  return `  - email ${e.id}: from ${e.from_name ?? ""} <${e.from_addr ?? ""}> (domain: ${e.domain ?? "?"}) | subject: ${e.subject ?? ""} | folder: ${e.folder_id ?? "(none)"}${flagStr} | snippet: ${(e.snippet ?? "").slice(0, 140)}${reason}`;
}

function buildPrompt(args: {
  history: AssistantChatMessage[];
  userMessage: string;
  emails: AssistantContextEmail[];
  folders: AssistantContextFolder[];
  folderSample?: { folderId: string; folderName: string; emails: AssistantContextEmail[] };
  domainClusters?: DomainCluster[];
  extraReminder?: string;
}) {
  const folderBlock = args.folders
    .map((f) => {
      const filters = f.filters.length
        ? f.filters.map((r) => `      - filter ${r.id}: ${r.field} ${r.op} "${r.value}"`).join("\n")
        : "      (no filters)";
      return `  - folder ${f.id}: "${f.name}"
      rule: ${f.ai_rule || "(none)"}
      learned profile: ${f.learned_profile ? f.learned_profile.slice(0, 400) : "(none)"}
${filters}`;
    })
    .join("\n");

  const emailBlock = args.emails.length
    ? args.emails.map(describeContextEmail).join("\n")
    : "  (none — user has not selected any emails)";

  const folderSampleBlock =
    args.folderSample && args.folderSample.emails.length
      ? `\nRecent emails currently in "${args.folderSample.folderName}" (folder ${args.folderSample.folderId}) — inspect these to diagnose misfiling:\n${args.folderSample.emails.map(describeContextEmail).join("\n")}\n`
      : "";

  const domainBlock =
    args.domainClusters && args.domainClusters.length
      ? `\nRecent sender-domain clusters (where mail from each domain currently lands) — use these to suggest durable domain filters:\n${args.domainClusters
          .map(
            (c) =>
              `  - ${c.domain}: ${c.count} recent emails → ${c.folders.map((f) => `${f.name} (${f.count})`).join(", ")}`,
          )
          .join("\n")}\n`
      : "";

  const historyBlock = args.history.length
    ? args.history.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n")
    : "(no prior turns)";

  return `You are an email organizer assistant for the user's inbox app. The user describes how they want emails sorted, and you propose concrete changes to folders and filter rules. You DO NOT execute changes — the user approves them in the UI.

Available folders (use these EXACT IDs — never invent IDs):
${folderBlock}

Currently selected emails (use these EXACT email IDs):
${emailBlock}
${folderSampleBlock}${domainBlock}
Prior conversation:
${historyBlock}

User's new message:
"${args.userMessage}"

Action types:
- move_email: move ONE selected email (by email_id) to a different folder.
- move_matching: move ALL existing emails matching a signal (field/op/value) into a folder. Use this — not many move_email actions — when several emails share the same sender, domain, or subject. Almost always pair it with add_filter so FUTURE mail follows too.
- add_filter: add a filter rule to a folder. Fields: from (sender address), domain (bare domain like "acme.com"), subject. Ops: contains, equals, starts_with.
- remove_filter: remove an existing filter by filter_id (only if it routes mail to the WRONG folder).
- update_folder_rule: replace a folder's short natural-language AI rule.
- update_folder_profile: rewrite the folder's longer learned profile (the description that steers the AI classifier). Use this to fix classifier drift — e.g. to explicitly EXCLUDE a class of mail that keeps getting misfiled.

How to diagnose (do this before proposing actions):
1. Look across the selected emails, the recent folder sample, and the domain clusters to find the SHARED signal causing the problem — a sender address, a bare domain, a mailing-list id, a subject pattern, or reply-vs-automated.
2. Prefer DURABLE, structural fixes over one-off moves: a domain filter beats repeated single moves; when many existing emails share a signal, propose move_matching + add_filter together.
3. Check whether a filter on ANOTHER folder is wrongly catching this mail; if so, propose remove_filter for that competing filter.
4. When the misfiling is fuzzy (the AI classifier, not a filter), tighten the folder's rule or learned profile to EXCLUDE the misfiled class precisely (e.g. "human replies in a thread are NOT automated invites") rather than broadening it.

Guidelines:
- Prefer the smallest set of changes that actually fixes the pattern.
- You do NOT need a selected email to add a filter, move matching mail, or refine instructions.
- Match folders by name fuzzily (case-insensitive, ignore plural/singular) against the list above. Always reference folder/filter/email IDs from the lists above — never invent IDs.
- Put a short, concrete reason in each action's "why".
- "reply" is a short friendly summary of what you'll change. "clarifying_question" is a single short question only if you truly cannot proceed, otherwise empty.

Prefer calling the propose_changes tool. Only reply in plain text if you genuinely need to ask a clarifying question and cannot express it via the tool's clarifying_question field.${args.extraReminder ? `\n${args.extraReminder}` : ""}`;
}

const TOOL_PARAMETERS_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "Short friendly summary of what you will change." },
    clarifying_question: {
      type: "string",
      description: "A single short question if you cannot proceed; otherwise empty.",
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "move_email",
              "move_matching",
              "add_filter",
              "remove_filter",
              "update_folder_rule",
              "update_folder_profile",
            ],
          },
          email_id: { type: "string", description: "Required when type is move_email." },
          to_folder_id: {
            type: "string",
            description: "Required when type is move_email or move_matching.",
          },
          folder_id: {
            type: "string",
            description:
              "Required when type is add_filter, update_folder_rule, or update_folder_profile.",
          },
          filter_id: { type: "string", description: "Required when type is remove_filter." },
          field: {
            type: "string",
            enum: ["from", "domain", "subject"],
            description: "Required when type is add_filter or move_matching.",
          },
          op: {
            type: "string",
            enum: ["contains", "equals", "starts_with"],
            description: "Required when type is add_filter or move_matching.",
          },
          value: {
            type: "string",
            description: "Required when type is add_filter or move_matching.",
          },
          ai_rule: { type: "string", description: "Required when type is update_folder_rule." },
          learned_profile: {
            type: "string",
            description: "Required when type is update_folder_profile.",
          },
          why: { type: "string", description: "Optional short reason." },
        },
        required: ["type"],
      },
    },
  },
  required: ["actions"],
} as const;

type ToolCall = { function?: { name?: string; arguments?: string } };
type GatewayChoice = { message?: { content?: string | null; tool_calls?: ToolCall[] } };
type GatewayResponse = { choices?: GatewayChoice[] };

async function callModel(prompt: string): Promise<AssistantProposal> {
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
      messages: [{ role: "user", content: prompt }],
      tools: [
        {
          type: "function",
          function: {
            name: "propose_changes",
            description:
              "Return your reply, optional clarifying question, and the list of proposed actions.",
            parameters: TOOL_PARAMETERS_SCHEMA,
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
    const validActions: AssistantAction[] = [];
    for (const a of rawActions) {
      const parsed = actionSchema.safeParse(a);
      if (parsed.success) validActions.push(parsed.data);
    }
    const final = proposalSchema.safeParse({
      reply: typeof rawObj.reply === "string" ? rawObj.reply : "",
      clarifying_question:
        typeof rawObj.clarifying_question === "string" ? rawObj.clarifying_question : "",
      actions: validActions,
    });
    if (!final.success) throw new Error("Proposal failed final validation");
    return final.data as AssistantProposal;
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

export async function proposeAssistantChanges(args: {
  history: AssistantChatMessage[];
  userMessage: string;
  emails: AssistantContextEmail[];
  folders: AssistantContextFolder[];
  folderSample?: { folderId: string; folderName: string; emails: AssistantContextEmail[] };
  domainClusters?: DomainCluster[];
}): Promise<AssistantProposal> {
  try {
    return await callModel(buildPrompt(args));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("proposeAssistantChanges first attempt failed", msg);
    // One retry with a stronger reminder for schema/no-object failures.
    if (/schema|no object|did not call|parse/i.test(msg)) {
      try {
        return await callModel(
          buildPrompt({
            ...args,
            extraReminder:
              "Respond ONLY by calling the propose_changes tool with valid JSON arguments. Do not write any prose outside the tool call.",
          }),
        );
      } catch (err2: unknown) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        console.error("proposeAssistantChanges retry failed", msg2);
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
