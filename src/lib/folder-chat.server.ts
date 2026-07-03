// Server-only helper that asks Lovable AI to translate a user's chat
// instruction into a structured proposal of changes to ONE folder's
// settings, rules, and filters. The model never writes to the DB — it emits
// actions the user approves in the folder chat panel.
//
// We call the Lovable AI Gateway directly (OpenAI-style function calling)
// rather than the AI SDK's tool() abstraction, because Gemini handles flat
// JSON-schema objects reliably but chokes on discriminated unions.
import { z } from "zod";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-3-flash-preview";

// Partial patch of scalar/boolean folder settings. Every field optional — the
// model only sets what it wants to change.
const settingsPatchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    auto_archive: z.boolean().optional(),
    auto_mark_read: z.boolean().optional(),
    auto_star: z.boolean().optional(),
    hide_from_inbox: z.boolean().optional(),
    skip_ai: z.boolean().optional(),
    overrides_inbox_override: z.boolean().optional(),
    is_cold_email: z.boolean().optional(),
    forward_to: z.string().max(320).nullable().optional(),
    snooze_hours: z.number().int().min(0).max(720).optional(),
    min_ai_confidence: z.number().min(0).max(1).optional(),
    filter_logic: z.enum(["any", "all"]).optional(),
  })
  .strict();

export type FolderSettingsPatch = z.infer<typeof settingsPatchSchema>;

const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_filter"),
    field: z.enum(["from", "domain", "subject"]),
    op: z.enum([
      "contains",
      "equals",
      "starts_with",
      "not_contains",
      "not_equals",
      "domain_in",
    ]),
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
    ai_rule: z.string().min(1).max(500),
    why: z.string().max(200).optional().default(""),
  }),
  z.object({
    type: z.literal("update_folder_profile"),
    learned_profile: z.string().min(1).max(2000),
    why: z.string().max(200).optional().default(""),
  }),
  z.object({
    type: z.literal("update_folder_settings"),
    settings: settingsPatchSchema,
    why: z.string().max(200).optional().default(""),
  }),
]);

export type FolderChatAction = z.infer<typeof actionSchema>;

const proposalSchema = z.object({
  reply: z.string().max(800).optional().default(""),
  clarifying_question: z.string().max(300).optional().default(""),
  actions: z.array(actionSchema).max(20).optional().default([]),
});

export type FolderChatProposal = {
  reply: string;
  clarifying_question: string;
  actions: FolderChatAction[];
};

export type FolderChatMessage = { role: "user" | "assistant"; content: string };

export type FolderChatContext = {
  id: string;
  name: string;
  color: string | null;
  priority: number | null;
  ai_rule: string | null;
  learned_profile: string | null;
  auto_archive: boolean | null;
  auto_mark_read: boolean | null;
  auto_star: boolean | null;
  hide_from_inbox: boolean | null;
  skip_ai: boolean | null;
  overrides_inbox_override: boolean | null;
  is_cold_email: boolean | null;
  forward_to: string | null;
  snooze_hours: number | null;
  min_ai_confidence: number | null;
  filter_logic: string | null;
  filters: Array<{ id: string; field: string; op: string; value: string }>;
};

export type FolderChatSampleEmail = {
  from_name: string | null;
  from_addr: string | null;
  subject: string | null;
  snippet: string | null;
  is_reply: boolean;
  classification_reason: string | null;
};

function buildPrompt(args: {
  history: FolderChatMessage[];
  userMessage: string;
  folder: FolderChatContext;
  sample: FolderChatSampleEmail[];
  extraReminder?: string;
}) {
  const f = args.folder;
  const filterBlock = f.filters.length
    ? f.filters.map((r) => `    - filter ${r.id}: ${r.field} ${r.op} "${r.value}"`).join("\n")
    : "    (no filters)";

  const settingsBlock = [
    `  name: "${f.name}"`,
    `  color: ${f.color ?? "(none)"}`,
    `  priority: ${f.priority ?? 0}`,
    `  ai_rule: ${f.ai_rule || "(none)"}`,
    `  learned_profile: ${f.learned_profile ? f.learned_profile.slice(0, 500) : "(none)"}`,
    `  auto_archive: ${!!f.auto_archive}`,
    `  auto_mark_read: ${!!f.auto_mark_read}`,
    `  auto_star: ${!!f.auto_star}`,
    `  hide_from_inbox: ${!!f.hide_from_inbox}`,
    `  skip_ai (rules only): ${!!f.skip_ai}`,
    `  overrides_inbox_override (beat always-inbox): ${!!f.overrides_inbox_override}`,
    `  is_cold_email: ${!!f.is_cold_email}`,
    `  forward_to: ${f.forward_to || "(none)"}`,
    `  snooze_hours: ${f.snooze_hours ?? 0}`,
    `  min_ai_confidence: ${f.min_ai_confidence ?? 0} (0-1)`,
    `  filter_logic: ${f.filter_logic ?? "any"}`,
  ].join("\n");

  const sampleBlock = args.sample.length
    ? args.sample
        .map(
          (e) =>
            `    - from ${e.from_name ?? ""} <${e.from_addr ?? ""}> | subject: ${e.subject ?? ""}${e.is_reply ? " [reply]" : ""} | snippet: ${(e.snippet ?? "").slice(0, 120)}${e.classification_reason ? ` | why: ${e.classification_reason.slice(0, 100)}` : ""}`,
        )
        .join("\n")
    : "    (no recent emails in this folder)";

  const historyBlock = args.history.length
    ? args.history.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n")
    : "(no prior turns)";

  return `You are an assistant that edits the settings of ONE email folder in the user's inbox app. The user describes what they want, and you propose concrete changes to THIS folder only. You DO NOT execute changes — the user approves them in the UI.

Folder "${f.name}" (id ${f.id}) — current settings:
${settingsBlock}
  filters:
${filterBlock}

Recent emails currently in this folder (to help you diagnose misfiling):
${sampleBlock}

Prior conversation:
${historyBlock}

User's new message:
"${args.userMessage}"

Action types (all scoped to THIS folder):
- add_filter: add a filter rule. Fields: from (sender address), domain (bare domain like "acme.com"), subject. Ops: contains, equals, starts_with.
- remove_filter: remove an existing filter by filter_id (only from the list above).
- update_folder_rule: replace the folder's short natural-language AI rule.
- update_folder_profile: rewrite the folder's longer learned profile (the description that steers the AI classifier). Use to fix classifier drift — e.g. to explicitly EXCLUDE a class of mail that keeps getting misfiled.
- update_folder_settings: change any of these fields (set only the ones that need to change): name, color (hex like "#22c55e"), priority (integer), auto_archive, auto_mark_read, auto_star, hide_from_inbox, skip_ai (rules only — never let AI assign to this folder), overrides_inbox_override (beat "always send to inbox" rules), is_cold_email, forward_to (email address or null to clear), snooze_hours (0-720), min_ai_confidence (0-1), filter_logic ("any" or "all").

Guidelines:
- Propose the smallest set of changes that fulfills the request.
- Map color names to sensible hex values (e.g. green → "#22c55e", blue → "#3b82f6", red → "#ef4444").
- Never invent filter_ids — only use ids from the list above.
- Put a short, concrete reason in each action's "why".
- "reply" is a short friendly summary. "clarifying_question" is a single short question only if you truly cannot proceed, otherwise empty.

Prefer calling the propose_changes tool. Only reply in plain text if you genuinely need a clarifying question and cannot express it via the tool's clarifying_question field.${args.extraReminder ? `\n${args.extraReminder}` : ""}`;
}

const SETTINGS_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    color: { type: "string", description: "Hex color like #22c55e." },
    priority: { type: "integer" },
    auto_archive: { type: "boolean" },
    auto_mark_read: { type: "boolean" },
    auto_star: { type: "boolean" },
    hide_from_inbox: { type: "boolean" },
    skip_ai: { type: "boolean", description: "Rules only — never let AI assign here." },
    overrides_inbox_override: { type: "boolean", description: "Beat always-send-to-inbox rules." },
    is_cold_email: { type: "boolean" },
    forward_to: { type: "string", description: "Email address, or empty string to clear." },
    snooze_hours: { type: "integer" },
    min_ai_confidence: { type: "number", description: "0 to 1." },
    filter_logic: { type: "string", enum: ["any", "all"] },
  },
} as const;

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
              "add_filter",
              "remove_filter",
              "update_folder_rule",
              "update_folder_profile",
              "update_folder_settings",
            ],
          },
          filter_id: { type: "string", description: "Required when type is remove_filter." },
          field: {
            type: "string",
            enum: ["from", "domain", "subject"],
            description: "Required when type is add_filter.",
          },
          op: {
            type: "string",
            enum: ["contains", "equals", "starts_with"],
            description: "Required when type is add_filter.",
          },
          value: { type: "string", description: "Required when type is add_filter." },
          ai_rule: { type: "string", description: "Required when type is update_folder_rule." },
          learned_profile: {
            type: "string",
            description: "Required when type is update_folder_profile.",
          },
          settings: {
            ...SETTINGS_SCHEMA,
            description: "Required when type is update_folder_settings.",
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

async function callModel(prompt: string): Promise<FolderChatProposal> {
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
              "Return your reply, optional clarifying question, and the list of proposed folder changes.",
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
    const rawObj = (raw ?? {}) as {
      reply?: unknown;
      clarifying_question?: unknown;
      actions?: unknown;
    };
    const rawActions = Array.isArray(rawObj.actions) ? rawObj.actions : [];
    const validActions: FolderChatAction[] = [];
    for (const a of rawActions) {
      // Normalize an empty-string forward_to to null before validating.
      if (
        a &&
        typeof a === "object" &&
        (a as { type?: unknown }).type === "update_folder_settings"
      ) {
        const s = (a as { settings?: Record<string, unknown> }).settings;
        if (s && s.forward_to === "") s.forward_to = null;
      }
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
    return final.data as FolderChatProposal;
  }

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

export async function proposeFolderChatChanges(args: {
  history: FolderChatMessage[];
  userMessage: string;
  folder: FolderChatContext;
  sample: FolderChatSampleEmail[];
}): Promise<FolderChatProposal> {
  try {
    return await callModel(buildPrompt(args));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("proposeFolderChatChanges first attempt failed", msg);
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
        console.error("proposeFolderChatChanges retry failed", msg2);
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
