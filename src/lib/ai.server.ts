// AI classification & summarization. Server-only.
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway";

function getModel() {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  return createLovableAiGatewayProvider(key)("google/gemini-3-flash-preview");
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
  if (folders.length === 0) return { folder_id: null as string | null, confidence: 0, summary: "" };

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

  const { output } = await generateText({
    model: getModel(),
    output: Output.object({
      schema: z.object({
        folder_name: z.string().describe("Exact name of the chosen folder, or 'NONE' if no folder fits"),
        confidence: z.number().min(0).max(1),
        summary: z.string().max(140).describe("One-line summary of the email"),
      }),
    }),
    prompt: `You categorize incoming emails into the user's folders based on each folder's rule, learned profile, and example emails.

Folders:
${folderList}

Email:
From: ${email.from_name} <${email.from_addr}>
Subject: ${email.subject}
Body:
${(email.body_text || email.snippet || "").slice(0, 4000)}

Choose the BEST matching folder, or "NONE" if nothing fits. Provide a one-line summary.`,
  });

  const match = folders.find((f) => f.name.toLowerCase() === output.folder_name.toLowerCase());
  return {
    folder_id: match?.id ?? null,
    confidence: output.confidence,
    summary: output.summary,
  };
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
