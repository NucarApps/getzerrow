// Server-only helper that asks Lovable AI to translate a user's chat
// instruction into a structured proposal of folder/filter changes. The
// model never writes to the DB — it just emits actions for the user to
// approve in the assistant panel.
//
// The gateway plumbing (tool call, response parsing, retry/error handling)
// lives in lovable-gateway.server; this file supplies only the assistant's
// prompt, tool schema, and action schema.
import { z } from "zod";
import type { DomainCluster } from "./ai-assistant-context";
import { proposeWithRetry } from "./lovable-gateway.server";
import {
  sanitizeUntrustedText,
  wrapUntrustedEmail,
  UNTRUSTED_BOUNDARY_INSTRUCTION,
} from "./ai-untrusted";

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

/** Every field below is attacker-controlled email text going into an
 * instruction block, so it gets the same treatment as the classifier's:
 * role lines, closing tags, backtick runs and invisible characters are
 * stripped before interpolation (see ai-untrusted.ts). */
const clean = (v: string | null | undefined, max: number) =>
  v ? sanitizeUntrustedText(v, max).text : "";

function describeContextEmail(e: AssistantContextEmail): string {
  const flags: string[] = [];
  if (e.is_reply) flags.push("reply");
  if (e.list_id) flags.push("mailing-list");
  const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
  const reason = e.classification_reason ? ` | why: ${clean(e.classification_reason, 120)}` : "";
  return `  - email ${e.id}: from ${clean(e.from_name, 120)} <${clean(e.from_addr, 160)}> (domain: ${clean(e.domain, 120) || "?"}) | subject: ${clean(e.subject, 200)} | folder: ${e.folder_id ?? "(none)"}${flagStr} | snippet: ${clean(e.snippet, 140)}${reason}`;
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
      ? `\nRecent emails currently in "${args.folderSample.folderName}" (folder ${args.folderSample.folderId}) — inspect these to diagnose misfiling:\n${wrapUntrustedEmail(args.folderSample.emails.map(describeContextEmail).join("\n"))}\n`
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

${UNTRUSTED_BOUNDARY_INSTRUCTION}

Available folders (use these EXACT IDs — never invent IDs):
${folderBlock}

Currently selected emails (use these EXACT email IDs):
${wrapUntrustedEmail(emailBlock)}
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

export async function proposeAssistantChanges(args: {
  history: AssistantChatMessage[];
  userMessage: string;
  emails: AssistantContextEmail[];
  folders: AssistantContextFolder[];
  folderSample?: { folderId: string; folderName: string; emails: AssistantContextEmail[] };
  domainClusters?: DomainCluster[];
}): Promise<AssistantProposal> {
  return proposeWithRetry<AssistantAction>({
    label: "proposeAssistantChanges",
    buildPrompt: (extraReminder) => buildPrompt({ ...args, extraReminder }),
    toolDescription:
      "Return your reply, optional clarifying question, and the list of proposed actions.",
    toolParametersSchema: TOOL_PARAMETERS_SCHEMA,
    actionSchema,
  });
}
