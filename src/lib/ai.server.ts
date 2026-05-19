// AI classification & summarization. Server-only.
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway";

function getModel() {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  return createLovableAiGatewayProvider(key)("google/gemini-3-flash-preview");
}

export async function classifyEmail(email: {
  from_addr: string;
  from_name: string;
  subject: string;
  snippet: string;
  body_text: string;
}, folders: Array<{ id: string; name: string; ai_rule: string | null }>) {
  if (folders.length === 0) return { folder_id: null as string | null, confidence: 0, summary: "" };

  const folderList = folders
    .map((f, i) => `${i + 1}. "${f.name}"${f.ai_rule ? ` — rule: ${f.ai_rule}` : ""}`)
    .join("\n");

  const { output } = await generateText({
    model: getModel(),
    output: Output.object({
      schema: z.object({
        folder_name: z.string().describe("Exact name of the chosen folder, or 'NONE' if no folder fits"),
        confidence: z.number().min(0).max(1),
        summary: z.string().max(140).describe("One-line summary of the email"),
      }),
    }),
    prompt: `You categorize incoming emails into the user's folders based on each folder's rule.

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
