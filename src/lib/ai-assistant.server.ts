// Server-only helper that asks Lovable AI to translate a user's chat
// instruction into a structured proposal of folder/filter changes. The
// model never writes to the DB — it just emits actions for the user to
// approve in the assistant panel.
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway";

function getModel(modelId: string = "google/gemini-2.5-flash") {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  return createLovableAiGatewayProvider(key)(modelId);
}

const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("move_email"),
    email_id: z.string(),
    to_folder_id: z.string(),
    why: z.string().max(200),
  }),
  z.object({
    type: z.literal("add_filter"),
    folder_id: z.string(),
    field: z.enum(["from", "domain", "subject"]),
    op: z.enum(["contains", "equals", "starts_with"]),
    value: z.string().min(1).max(400),
    why: z.string().max(200),
  }),
  z.object({
    type: z.literal("remove_filter"),
    filter_id: z.string(),
    why: z.string().max(200),
  }),
  z.object({
    type: z.literal("update_folder_rule"),
    folder_id: z.string(),
    ai_rule: z.string().min(1).max(500),
    why: z.string().max(200),
  }),
]);

export type AssistantAction = z.infer<typeof actionSchema>;

const proposalSchema = z.object({
  reply: z
    .string()
    .max(800)
    .describe("Friendly 1-3 sentence reply summarizing what you'll do. Empty if you only need to ask a clarifying question."),
  clarifying_question: z
    .string()
    .max(300)
    .describe("If the request is ambiguous, ask ONE short clarifying question. Otherwise empty string."),
  actions: z.array(actionSchema).max(20),
});

export type AssistantProposal = z.infer<typeof proposalSchema>;

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

export async function proposeAssistantChanges(args: {
  history: AssistantChatMessage[];
  userMessage: string;
  emails: AssistantContextEmail[];
  folders: AssistantContextFolder[];
}): Promise<AssistantProposal> {
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

  const prompt = `You are an email organizer assistant for the user's inbox app. The user describes how they want emails to be sorted, and you propose concrete changes to their folders and filter rules. You DO NOT execute the changes — the user reviews and approves them in the UI.

Available folders (use these EXACT folder IDs — never invent IDs):
${folderBlock}

Currently selected emails (use these EXACT email IDs):
${emailBlock}

Prior conversation:
${historyBlock}

User's new message:
"${args.userMessage}"

Action types you can propose:
- move_email: move a specific selected email to a different folder.
- add_filter: add a filter rule to a folder. Fields: from (matches sender address), domain (matches sender's domain — value should be the bare domain like "acme.com"), subject (matches subject text). Ops: contains, equals, starts_with.
- remove_filter: remove an existing filter rule by its filter_id (only if it currently routes to the WRONG folder).
- update_folder_rule: replace a folder's natural-language AI rule with a refined version.

Guidelines:
- Prefer the smallest set of changes that satisfies the user.
- If the user wants future similar emails routed differently, ALWAYS propose an add_filter on the correct folder. If a competing filter is sending these emails to the wrong folder, also propose remove_filter for it.
- Only reference folder IDs and filter IDs that appear above. Never make up IDs.
- Only reference email IDs from the "selected emails" list. If the user refers to "this email" / "these" but nothing is selected, ask a clarifying question instead of proposing actions.
- Each action's "why" is one short plain-English sentence the user will see.
- "reply" is a friendly summary like "I'll move this email to Marketing and add a domain filter so future @acme.com mail lands there." Keep it short.
- If the request is too vague to act on safely, set actions=[] and put your one short question in clarifying_question.`;

  try {
    const { output } = await generateText({
      model: getModel(),
      output: Output.object({ schema: proposalSchema }),
      prompt,
    });
    return output as AssistantProposal;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("proposeAssistantChanges failed", msg);
    return {
      reply: "",
      clarifying_question:
        "Sorry, I couldn't reach the AI right now. Could you try sending that again in a moment?",
      actions: [],
    };
  }
}
