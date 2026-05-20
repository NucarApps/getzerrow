// AI classification & summarization. Server-only.
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway";

function getModel(modelId: string = "google/gemini-2.5-flash") {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  return createLovableAiGatewayProvider(key)(modelId);
}

export type ClassifyFolder = {
  id: string;
  name: string;
  ai_rule: string | null;
  learned_profile?: string | null;
  examples?: Array<{ from_addr: string | null; subject: string | null }>;
};

export async function classifyEmail(email: {
  from_addr: string;
  from_name: string;
  subject: string;
  snippet: string;
  body_text: string;
}, folders: ClassifyFolder[]) {
  if (folders.length === 0) return { folder_id: null as string | null, confidence: 0, summary: "", reason: "" };

  const folderList = folders
    .map((f, i) => {
      const parts = [`${i + 1}. "${f.name}"`];
      if (f.ai_rule) parts.push(`Rule: ${f.ai_rule}`);
      if (f.learned_profile) parts.push(`Learned profile: ${f.learned_profile}`);
      if (f.examples && f.examples.length) {
        const ex = f.examples.slice(0, 5).map((e) => `  - "${e.subject ?? ""}" from ${e.from_addr ?? ""}`).join("\n");
        parts.push(`Recent examples:\n${ex}`);
      }
      return parts.join("\n   ");
    })
    .join("\n\n");

  const folderNames = folders.map((f) => f.name);
  const schema = z.object({
    folder_name: z.string().describe("Exact name of the chosen folder, or 'NONE' if no folder fits"),
    confidence: z.number().min(0).max(1),
    summary: z.string().max(140).describe("One-line summary of the email"),
    reason: z.string().max(200).describe("Short explanation of WHY this folder was chosen — cite the folder rule, profile, or example pattern that matched. If 'NONE', explain why nothing fit."),
  });

  const basePrompt = `You categorize incoming emails into the user's folders based on each folder's rule, learned profile, and example emails.

Folders:
${folderList}

Email:
From: ${email.from_name} <${email.from_addr}>
Subject: ${email.subject}
Body:
${(email.body_text || email.snippet || "").slice(0, 4000)}

Choose the BEST matching folder, or "NONE" if nothing fits. Provide a one-line summary AND a short reason explaining the match.`;

  type Out = z.infer<typeof schema>;

  async function tryStructured(modelId: string): Promise<Out | null> {
    try {
      const { output } = await generateText({
        model: getModel(modelId),
        output: Output.object({ schema }),
        prompt: basePrompt,
      });
      return output as Out;
    } catch (e) {
      console.error(`classify structured failed (${modelId})`, (e as Error)?.message);
      return null;
    }
  }

  async function tryTextJson(modelId: string): Promise<Out | null> {
    try {
      const { text } = await generateText({
        model: getModel(modelId),
        prompt: `${basePrompt}

Respond with ONLY a JSON object (no markdown, no prose, no code fences) of this exact shape:
{"folder_name":"<one of: ${folderNames.map((n) => `"${n}"`).join(", ")} or \\"NONE\\">","confidence":<0..1>,"summary":"<<=140 chars>","reason":"<<=200 chars>"}`,
      });
      const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return schema.parse(parsed);
    } catch (e) {
      console.error(`classify text-json failed (${modelId})`, (e as Error)?.message);
      return null;
    }
  }

  let output =
    (await tryStructured("google/gemini-2.5-flash")) ||
    (await tryTextJson("google/gemini-2.5-flash")) ||
    (await tryStructured("google/gemini-2.5-flash-lite")) ||
    (await tryTextJson("google/gemini-2.5-flash-lite"));

  if (!output) throw new Error("AI classifier returned no parseable response");

  const match = folders.find((f) => f.name.toLowerCase() === output!.folder_name.toLowerCase());
  return {
    folder_id: match?.id ?? null,
    confidence: output.confidence,
    summary: output.summary,
    reason: output.reason,
  };
}

export async function summarizeEmail(email: {
  from_name: string;
  from_addr: string;
  subject: string;
  body_text: string;
  snippet: string;
}): Promise<string> {
  const { text } = await generateText({
    model: getModel("google/gemini-2.5-flash-lite"),
    prompt: `Write a single-sentence summary (max 140 chars) of this email — what it's about and what (if anything) the sender wants. No greetings, no preamble, no quotes.

From: ${email.from_name} <${email.from_addr}>
Subject: ${email.subject}

${(email.body_text || email.snippet || "").slice(0, 4000)}`,
  });
  return text.trim().replace(/^["']|["']$/g, "").slice(0, 140);
}

export async function buildFolderProfile(
  folderName: string,
  rule: string | null,
  examples: Array<{ from_addr: string | null; subject: string | null; snippet: string | null }>
): Promise<string> {
  if (examples.length === 0) return "";
  const list = examples.slice(0, 50).map((e, i) =>
    `${i + 1}. From: ${e.from_addr ?? ""} | Subject: ${e.subject ?? ""} | Snippet: ${(e.snippet ?? "").slice(0, 160)}`
  ).join("\n");
  const { text } = await generateText({
    model: getModel(),
    prompt: `Describe the kind of email that belongs in the folder "${folderName}" in 1-3 sentences.
Focus on senders, subject patterns, topics, and intent. Be concrete.
${rule ? `User's stated rule: ${rule}\n` : ""}
Example emails in this folder:
${list}

Output only the description, no preamble.`,
  });
  return text.trim();
}

export async function suggestReply(email: {
  from_name: string;
  subject: string;
  body_text: string;
}) {
  const { text } = await generateText({
    model: getModel(),
    prompt: `Write a concise, friendly reply to this email. Output just the reply body, no signature, no subject line.

From: ${email.from_name}
Subject: ${email.subject}

${(email.body_text || "").slice(0, 4000)}`,
  });
  return text.trim();
}

export type RuleSuggestion = {
  source: { proposed_rule: string; proposed_profile: string; why: string };
  target: { proposed_rule: string; proposed_profile: string; why: string };
};

export async function suggestRuleUpdates(args: {
  email: { from_addr: string; from_name: string; subject: string; snippet: string; body_text: string };
  source: { name: string; ai_rule: string | null; learned_profile: string | null };
  target: { name: string; ai_rule: string | null; learned_profile: string | null };
}): Promise<RuleSuggestion> {
  const { output } = await generateText({
    model: getModel(),
    output: Output.object({
      schema: z.object({
        source: z.object({
          proposed_rule: z.string().max(500),
          proposed_profile: z.string().max(800),
          why: z.string().max(200),
        }),
        target: z.object({
          proposed_rule: z.string().max(500),
          proposed_profile: z.string().max(800),
          why: z.string().max(200),
        }),
      }),
    }),
    prompt: `An email was misclassified. The user is moving it from "${args.source.name}" to "${args.target.name}". Propose updated rules and learned profiles for BOTH folders so this kind of email is routed correctly next time.

SOURCE folder "${args.source.name}" (wrong destination):
- Current rule: ${args.source.ai_rule || "(none)"}
- Current learned profile: ${args.source.learned_profile || "(none)"}

TARGET folder "${args.target.name}" (correct destination):
- Current rule: ${args.target.ai_rule || "(none)"}
- Current learned profile: ${args.target.learned_profile || "(none)"}

The misclassified email:
From: ${args.email.from_name} <${args.email.from_addr}>
Subject: ${args.email.subject}
Body: ${(args.email.body_text || args.email.snippet || "").slice(0, 2000)}

Guidelines:
- Refine, don't rewrite. Keep most of the existing wording.
- SOURCE: tighten so emails like this one are NOT included. Add a brief exclusion clause if useful.
- TARGET: broaden/clarify so emails like this one ARE included. Mention concrete signals (sender domain, subject keywords, intent).
- Each rule: at most 2 short sentences. Each profile: at most 3 short sentences.
- "why": one plain-English line.`,
  });
  return output as RuleSuggestion;
}

export type FolderSummaryOutput = {
  subject: string;
  body_text: string;
  body_html: string;
};

export async function summarizeFolderEmails(args: {
  folderName: string;
  instructions: string;
  emails: Array<{
    from_addr: string | null;
    from_name: string | null;
    subject: string | null;
    snippet: string | null;
    received_at: string | null;
  }>;
}): Promise<FolderSummaryOutput> {
  const list = args.emails
    .slice(0, 200)
    .map((e, i) => {
      const when = e.received_at ? new Date(e.received_at).toISOString() : "";
      const who = e.from_name ? `${e.from_name} <${e.from_addr ?? ""}>` : (e.from_addr ?? "");
      return `${i + 1}. [${when}] ${who}\n   Subject: ${e.subject ?? ""}\n   Snippet: ${(e.snippet ?? "").slice(0, 240)}`;
    })
    .join("\n");

  const { output } = await generateText({
    model: getModel(),
    output: Output.object({
      schema: z.object({
        subject: z.string().min(1).max(140).describe("Concise subject line for the digest email"),
        body_text: z.string().min(1).max(20000).describe("Plain-text digest body"),
        body_html: z.string().min(1).max(40000).describe("HTML digest body (semantic, inline-styled, no <html>/<body> tags)"),
      }),
    }),
    prompt: `You write a daily digest of emails that landed in the user's "${args.folderName}" folder.

User instructions for how to group and format the digest:
${args.instructions || "(none — use sensible defaults: group by sender or topic, surface action items, keep it scannable.)"}

Emails (most recent first):
${list}

Write:
- subject: short, mentions the folder and date range or count.
- body_text: clean plain-text version.
- body_html: well-structured HTML using headings, bullet lists, and bold for emphasis. Use simple inline styles only. No <html>, <head>, or <body> tags — just the inner content. Do not include images.

Be concise. Skip empty/duplicate content. If there are no emails, say so briefly.`,
  });

  return output;
}
