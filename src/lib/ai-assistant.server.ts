// Server-only helper that asks Lovable AI to translate a user's chat
// instruction into a structured proposal of folder/filter changes. The
// model never writes to the DB — it just emits actions for the user to
// approve in the assistant panel.
import { generateText, tool } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway";

function getModel(modelId: string = "google/gemini-3-flash-preview") {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  return createLovableAiGatewayProvider(key)(modelId);
}

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
};

export type AssistantContextFolder = {
  id: string;
  name: string;
  ai_rule: string | null;
  filters: Array<{ id: string; field: string; op: string; value: string }>;
};

export type AssistantChatMessage = { role: "user" | "assistant"; content: string };

function buildPrompt(args: {
  history: AssistantChatMessage[];
  userMessage: string;
  emails: AssistantContextEmail[];
  folders: AssistantContextFolder[];
  extraReminder?: string;
}) {
  const folderBlock = args.folders
    .map((f) => {
      const filters = f.filters.length
        ? f.filters
            .map((r) => `      - filter ${r.id}: ${r.field} ${r.op} "${r.value}"`)
            .join("\n")
        : "      (no filters)";
      return `  - folder ${f.id}: "${f.name}"
      rule: ${f.ai_rule || "(none)"}
${filters}`;
    })
    .join("\n");

  const emailBlock = args.emails.length
    ? args.emails
        .map(
          (e) =>
            `  - email ${e.id}: from ${e.from_name ?? ""} <${e.from_addr ?? ""}> | subject: ${e.subject ?? ""} | folder: ${e.folder_id ?? "(none)"} | snippet: ${(e.snippet ?? "").slice(0, 160)}`,
        )
        .join("\n")
    : "  (none — user has not selected any emails)";

  const historyBlock = args.history.length
    ? args.history.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n")
    : "(no prior turns)";

  return `You are an email organizer assistant for the user's inbox app. The user describes how they want emails sorted, and you propose concrete changes to folders and filter rules. You DO NOT execute changes — the user approves them in the UI.

Available folders (use these EXACT IDs — never invent IDs):
${folderBlock}

Currently selected emails (use these EXACT email IDs):
${emailBlock}

Prior conversation:
${historyBlock}

User's new message:
"${args.userMessage}"

Action types:
- move_email: move a selected email to a different folder.
- add_filter: add a filter rule to a folder. Fields: from (sender address), domain (bare domain like "acme.com"), subject. Ops: contains, equals, starts_with.
- remove_filter: remove an existing filter by filter_id (only if it routes to the WRONG folder).
- update_folder_rule: replace a folder's natural-language AI rule.

Guidelines:
- Prefer the smallest set of changes.
- If the user wants future similar emails routed differently, propose an add_filter on the correct folder. If a competing filter routes wrong, also propose remove_filter.
- Only reference folder/filter/email IDs from the lists above.
- If the user says "this email" but nothing is selected, leave actions empty and ask a clarifying question.
- "reply" is a short friendly summary. "clarifying_question" is a single short question if needed, otherwise empty.

You MUST respond by calling the propose_changes tool exactly once.${args.extraReminder ? `\n${args.extraReminder}` : ""}`;
}

async function callModel(prompt: string): Promise<AssistantProposal> {
  let captured: AssistantProposal | null = null;
  await generateText({
    model: getModel(),
    tools: {
      propose_changes: tool({
        description: "Return your reply, optional clarifying question, and the list of proposed actions.",
        inputSchema: proposalSchema,
        execute: async (input) => {
          captured = input as AssistantProposal;
          return { ok: true };
        },
      }),
    },
    toolChoice: { type: "tool", toolName: "propose_changes" },
    prompt,
  });
  if (!captured) throw new Error("Model did not call propose_changes");
  return captured;
}

export async function proposeAssistantChanges(args: {
  history: AssistantChatMessage[];
  userMessage: string;
  emails: AssistantContextEmail[];
  folders: AssistantContextFolder[];
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
          buildPrompt({ ...args, extraReminder: "Respond ONLY by calling the propose_changes tool with valid JSON arguments. Do not write any prose outside the tool call." }),
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
      question = "AI credits are exhausted for this workspace. Add credits in Settings → Workspace → Usage and try again.";
    } else if (/429|rate/i.test(msg)) {
      question = "Too many requests right now — please try again in a moment.";
    }
    return { reply: "", clarifying_question: question, actions: [] };
  }
}
