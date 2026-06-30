// AI classification & summarization. Server-only.
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway";
import {
  AI_BATCH_ATTEMPT_TIMEOUT_MS,
  AI_CLASSIFY_ATTEMPT_TIMEOUT_MS,
  AI_CLASSIFY_TOTAL_BUDGET_MS,
} from "./sync/config";

/** Race a promise against a hard per-attempt timeout so one stalled
 * upstream model call can't eat the whole classification budget. */
async function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

export async function classifyEmail(
  email: {
    from_addr: string;
    from_name: string;
    subject: string;
    snippet: string;
    body_text: string;
    in_reply_to?: string;
    has_calendar_invite?: boolean;
  },
  folders: ClassifyFolder[],
) {
  if (folders.length === 0)
    return { folder_id: null as string | null, confidence: 0, summary: "", reason: "" };

  function buildFolderList(includeExamples: boolean) {
    return folders
      .map((f, i) => {
        const parts = [`${i + 1}. "${f.name}"`];
        if (f.ai_rule) parts.push(`Rule: ${f.ai_rule}`);
        if (f.learned_profile) parts.push(`Learned profile: ${f.learned_profile}`);
        if (includeExamples && f.examples && f.examples.length) {
          const ex = f.examples
            .slice(0, 5)
            .map((e) => `  - "${e.subject ?? ""}" from ${e.from_addr ?? ""}`)
            .join("\n");
          parts.push(`Recent examples:\n${ex}`);
        }
        return parts.join("\n   ");
      })
      .join("\n\n");
  }

  const folderNames = folders.map((f) => f.name);
  // NOTE: use .transform() instead of .max() — Gemini routinely returns
  // strings longer than the soft cap. Hard validation made every fallback
  // model fail, bursting JOB_TIMEOUT_MS and leaving emails stuck at
  // classified_by='pending'. Truncate instead of reject.
  const schema = z.object({
    folder_name: z
      .string()
      .describe("Exact name of the chosen folder, or 'NONE' if no folder fits"),
    confidence: z.number().min(0).max(1),
    summary: z
      .string()
      .transform((s) => s.slice(0, 140))
      .describe("One-line summary of the email (<=140 chars)"),
    reason: z
      .string()
      .transform((s) => s.slice(0, 200))
      .describe("Short explanation of WHY this folder was chosen (<=200 chars)"),
  });

  function buildPrompt(opts: { trim: boolean }) {
    const bodyLimit = opts.trim ? 2000 : 4000;
    const isReply = !!(email.in_reply_to && email.in_reply_to.trim());
    const hasCalendarInvite = !!email.has_calendar_invite;
    return `You categorize incoming emails into the user's folders based on each folder's rule, learned profile, and example emails.

Folders:
${buildFolderList(!opts.trim)}

Email:
From: ${email.from_name} <${email.from_addr}>
Subject: ${email.subject}
Signals: ${hasCalendarInvite ? "carries a calendar event (.ics/text-calendar)" : "no calendar event attached"}; ${isReply ? "is a reply in an existing thread" : "is not a reply"}
Body:
${(email.body_text || email.snippet || "").slice(0, bodyLimit)}

Guidance: Treat an email as an automated calendar invite ONLY when it actually carries a calendar event. A human reply in an existing thread is NOT an automated invite — do not route it into an automated-invite folder unless that folder's rule explicitly targets replies.

Choose the BEST matching folder, or "NONE" if nothing fits. Provide a one-line summary AND a short reason explaining the match.`;
  }

  type Out = z.infer<typeof schema>;
  let lastError = "";

  function describeError(e: unknown): string {
    const err = e as {
      name?: unknown;
      status?: unknown;
      message?: unknown;
      responseBody?: unknown;
    };
    const parts: string[] = [];
    if (typeof err?.name === "string") parts.push(err.name);
    if (typeof err?.status === "number") parts.push(`status=${err.status}`);
    if (typeof err?.message === "string") parts.push(err.message);
    if (err?.responseBody != null) parts.push(`body=${String(err.responseBody).slice(0, 200)}`);
    return parts.join(" | ").slice(0, 400) || "unknown error";
  }

  const deadline = Date.now() + AI_CLASSIFY_TOTAL_BUDGET_MS;
  const budgetLeft = () => deadline - Date.now();

  async function tryStructured(modelId: string, trim: boolean): Promise<Out | null> {
    try {
      const { output } = await raceTimeout(
        generateText({
          model: getModel(modelId),
          output: Output.object({ schema }),
          prompt: buildPrompt({ trim }),
        }),
        Math.min(AI_CLASSIFY_ATTEMPT_TIMEOUT_MS, Math.max(budgetLeft(), 1)),
        `classify structured (${modelId})`,
      );
      return output as Out;
    } catch (e) {
      lastError = describeError(e);
      console.error(`classify structured failed (${modelId})`, lastError);
      return null;
    }
  }

  async function tryTextJson(modelId: string, trim: boolean): Promise<Out | null> {
    try {
      const { text } = await raceTimeout(
        generateText({
          model: getModel(modelId),
          prompt: `${buildPrompt({ trim })}

Respond with ONLY a JSON object (no markdown, no prose, no code fences) of this exact shape:
{"folder_name":"<one of: ${folderNames.map((n) => `"${n}"`).join(", ")} or \\"NONE\\">","confidence":<0..1>,"summary":"<<=140 chars>","reason":"<<=200 chars>"}`,
        }),
        Math.min(AI_CLASSIFY_ATTEMPT_TIMEOUT_MS, Math.max(budgetLeft(), 1)),
        `classify text-json (${modelId})`,
      );
      const cleaned = text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "");
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start < 0 || end <= start) {
        lastError = `empty/non-JSON response (len=${text.length})`;
        console.error(`classify text-json failed (${modelId})`, lastError);
        return null;
      }
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return schema.parse(parsed);
    } catch (e) {
      lastError = describeError(e);
      console.error(`classify text-json failed (${modelId})`, lastError);
      return null;
    }
  }

  // Run the cascade in budget-aware order: lead with the fastest model
  // (flash-lite) so the common case returns quickly, then escalate. Each
  // step is skipped once the total budget is exhausted.
  type Attempt = () => Promise<Out | null>;
  const cascade: Attempt[] = [
    () => tryStructured("google/gemini-2.5-flash-lite", false),
    () => tryTextJson("google/gemini-2.5-flash-lite", false),
    () => tryStructured("google/gemini-2.5-flash", false),
    () => tryTextJson("google/gemini-2.5-flash", false),
    () => tryTextJson("openai/gpt-5-mini", true),
    () => tryTextJson("openai/gpt-5-nano", true),
  ];

  let output: Out | null = null;
  for (const attempt of cascade) {
    if (budgetLeft() <= 0) {
      lastError = lastError || "classification budget exhausted";
      break;
    }
    output = await attempt();
    if (output) break;
  }

  if (!output)
    throw new Error(
      `AI classifier returned no parseable response (last error: ${lastError || "unknown"})`,
    );

  const match = folders.find((f) => f.name.toLowerCase() === output!.folder_name.toLowerCase());
  return {
    folder_id: match?.id ?? null,
    confidence: output.confidence,
    summary: output.summary,
    reason: output.reason,
  };
}

/**
 * Batch-classify multiple emails sharing the same folder set in a single
 * Gemini call. Returns one result per input email (in order). Used by the
 * backfill worker to amortize LLM round-trip latency across many messages.
 */
export async function classifyEmailsBatch(
  emails: Array<{
    from_addr: string;
    from_name: string;
    subject: string;
    snippet: string;
    body_text: string;
    in_reply_to?: string;
    has_calendar_invite?: boolean;
  }>,
  folders: ClassifyFolder[],
): Promise<
  Array<{ folder_id: string | null; confidence: number; summary: string; reason: string }>
> {
  if (emails.length === 0) return [];
  if (folders.length === 0) {
    return emails.map(() => ({ folder_id: null, confidence: 0, summary: "", reason: "" }));
  }

  const folderList = folders
    .map((f, i) => {
      const parts = [`${i + 1}. "${f.name}"`];
      if (f.ai_rule) parts.push(`Rule: ${f.ai_rule}`);
      if (f.learned_profile) parts.push(`Learned profile: ${f.learned_profile}`);
      if (f.examples?.length) {
        const ex = f.examples
          .slice(0, 3)
          .map((e) => `  - "${e.subject ?? ""}" from ${e.from_addr ?? ""}`)
          .join("\n");
        parts.push(`Recent examples:\n${ex}`);
      }
      return parts.join("\n   ");
    })
    .join("\n\n");

  const emailBlocks = emails
    .map((e, i) => {
      const isReply = !!(e.in_reply_to && e.in_reply_to.trim());
      const hasCal = !!e.has_calendar_invite;
      return `--- EMAIL ${i + 1} ---
From: ${e.from_name} <${e.from_addr}>
Subject: ${e.subject}
Signals: ${hasCal ? "carries a calendar event (.ics/text-calendar)" : "no calendar event attached"}; ${isReply ? "is a reply in an existing thread" : "is not a reply"}
Body:
${(e.body_text || e.snippet || "").slice(0, 1500)}`;
    })
    .join("\n\n");

  const itemSchema = z.object({
    index: z.number().int().min(1),
    folder_name: z.string(),
    confidence: z.number().min(0).max(1),
    summary: z.string().transform((s) => s.slice(0, 140)),
    reason: z.string().transform((s) => s.slice(0, 200)),
  });
  const schema = z.object({ results: z.array(itemSchema) });

  const prompt = `You categorize incoming emails into the user's folders based on each folder's rule, learned profile, and example emails.

Folders:
${folderList}

You are given ${emails.length} emails. For EACH one return an object with:
- index: the email number (1..${emails.length})
- folder_name: exact folder name, or "NONE" if no folder fits
- confidence: 0..1
- summary: one-line summary of THAT email (max 140 chars)
- reason: short explanation citing the rule/profile/example that matched (max 200 chars)

Emails:
${emailBlocks}

Return ONE result per email, in any order, with the correct \`index\`.`;

  type Out = z.infer<typeof schema>;
  let parsed: Out | null = null;
  let lastError = "";

  const describe = (e: unknown): string => {
    const err = e as { name?: unknown; status?: unknown; message?: unknown };
    const parts: string[] = [];
    if (typeof err?.name === "string") parts.push(err.name);
    if (typeof err?.status === "number") parts.push(`status=${err.status}`);
    if (typeof err?.message === "string") parts.push(err.message);
    return parts.join(" | ").slice(0, 300) || "unknown";
  };

  for (const modelId of ["google/gemini-2.5-flash-lite", "google/gemini-2.5-flash"]) {
    try {
      const { output } = await raceTimeout(
        generateText({
          model: getModel(modelId),
          output: Output.object({ schema }),
          prompt,
        }),
        AI_BATCH_ATTEMPT_TIMEOUT_MS,
        `classifyEmailsBatch (${modelId})`,
      );
      parsed = output as Out;
      break;
    } catch (e) {
      lastError = describe(e);
      console.error(`classifyEmailsBatch structured failed (${modelId})`, lastError);
    }
  }

  if (!parsed) throw new Error(`Batch classifier failed: ${lastError || "no parseable response"}`);

  const byIndex = new Map<number, z.infer<typeof itemSchema>>();
  for (const r of parsed.results) byIndex.set(r.index, r);

  return emails.map((_, i) => {
    const r = byIndex.get(i + 1);
    if (!r)
      return {
        folder_id: null,
        confidence: 0,
        summary: "",
        reason: "No batch result for this email",
      };
    const match = folders.find((f) => f.name.toLowerCase() === r.folder_name.toLowerCase());
    return {
      folder_id: match?.id ?? null,
      confidence: r.confidence,
      summary: r.summary,
      reason: r.reason,
    };
  });
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
  return text
    .trim()
    .replace(/^["']|["']$/g, "")
    .slice(0, 140);
}

export async function buildFolderProfile(
  folderName: string,
  rule: string | null,
  examples: Array<{ from_addr: string | null; subject: string | null; snippet: string | null }>,
): Promise<string> {
  if (examples.length === 0) return "";
  const list = examples
    .slice(0, 50)
    .map(
      (e, i) =>
        `${i + 1}. From: ${e.from_addr ?? ""} | Subject: ${e.subject ?? ""} | Snippet: ${(e.snippet ?? "").slice(0, 160)}`,
    )
    .join("\n");
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

export type SuggestedFolderShape = {
  name: string;
  color: string;
  ai_rule: string;
  filter_field: "from" | "domain" | "subject" | "list_id" | "" | null;
  filter_op: "contains" | "equals" | "starts_with" | "ends_with" | "" | null;
  filter_value: string;
  why: string;
};

export async function suggestFolderFromEmails(
  emails: Array<{
    from_addr: string | null;
    from_name: string | null;
    subject: string | null;
    snippet: string | null;
  }>,
): Promise<SuggestedFolderShape> {
  const list = emails
    .slice(0, 30)
    .map(
      (e, i) =>
        `${i + 1}. From: ${e.from_name ?? ""} <${e.from_addr ?? ""}>\n   Subject: ${e.subject ?? ""}\n   Snippet: ${(e.snippet ?? "").slice(0, 200)}`,
    )
    .join("\n\n");

  const palette = [
    "#f59e0b",
    "#10b981",
    "#3b82f6",
    "#ec4899",
    "#8b5cf6",
    "#ef4444",
    "#14b8a6",
    "#eab308",
  ];

  try {
    const { output } = await generateText({
      model: getModel(),
      output: Output.object({
        schema: z.object({
          name: z.string().min(1).max(40).describe("Short, human folder name in Title Case"),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .describe("Hex color from the palette"),
          ai_rule: z.string().min(1).max(300).describe("1-2 sentence natural-language rule"),
          filter_field: z
            .enum(["from", "domain", "subject", "list_id", ""])
            .describe("Optional concrete filter — empty if no single signal fits"),
          filter_op: z.enum(["contains", "equals", "starts_with", "ends_with", ""]),
          filter_value: z.string().max(200),
          why: z.string().max(200),
        }),
      }),
      prompt: `You are helping a user create a new email folder. Look at these unclassified emails and propose ONE new folder that would group most of them.

Emails:
${list}

Guidelines:
- Pick a name that describes the COMMON theme, not the literal sender.
- Pick a color hex from this palette: ${palette.join(", ")}
- ai_rule: 1-2 sentences a human would understand.
- filter_field/op/value: only fill in if there is one strong concrete signal (e.g. all from the same domain, or all subjects start with "RE: Daily Report"). Otherwise leave all three empty.
- why: one short line.`,
    });
    return output as SuggestedFolderShape;
  } catch (err: unknown) {
    console.error("suggestFolderFromEmails failed", err instanceof Error ? err.message : err);
    return {
      name: "New folder",
      color: palette[0],
      ai_rule: "Emails similar to the selected examples.",
      filter_field: null,
      filter_op: null,
      filter_value: "",
      why: "AI unavailable — using a generic suggestion.",
    };
  }
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
  email: {
    from_addr: string;
    from_name: string;
    subject: string;
    snippet: string;
    body_text: string;
  };
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
}): Promise<FolderSummaryOutput & { _fallback?: boolean }> {
  // Heavy custom prompts (e.g. Factory daily briefing) blow past the upstream
  // gateway budget when combined with long email lists. Trim aggressively when
  // the instructions are long.
  const longPrompt = (args.instructions ?? "").length > 1500;
  const maxEmails = longPrompt ? 100 : 150;
  const snippetLen = longPrompt ? 200 : 240;

  const list = args.emails
    .slice(0, maxEmails)
    .map((e, i) => {
      const when = e.received_at ? new Date(e.received_at).toISOString() : "";
      const who = e.from_name ? `${e.from_name} <${e.from_addr ?? ""}>` : (e.from_addr ?? "");
      return `${i + 1}. [${when}] ${who}\n   Subject: ${e.subject ?? ""}\n   Snippet: ${(e.snippet ?? "").slice(0, snippetLen)}`;
    })
    .join("\n");

  const basePrompt = `You write a daily digest of emails that landed in the user's "${args.folderName}" folder.

User instructions for how to group and format the digest:
${args.instructions || "(none — use sensible defaults: group by sender or topic, surface action items, keep it scannable.)"}

Emails (most recent first):
${list}`;

  // Race the AI call against a hard timeout so the background worker never
  // hangs on a stuck upstream response.
  const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race<T>([
        p,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const PRIMARY_MODEL = "google/gemini-3-flash-preview";

  // Primary: structured output with a fast model.
  try {
    const { output } = await withTimeout(
      generateText({
        model: getModel(PRIMARY_MODEL),
        output: Output.object({
          schema: z.object({
            subject: z
              .string()
              .min(1)
              .max(200)
              .describe("Concise subject line for the digest email"),
            body_text: z.string().min(1).describe("Plain-text digest body"),
            body_html: z
              .string()
              .min(1)
              .describe("HTML digest body (semantic, inline-styled, no <html>/<body> tags)"),
          }),
        }),
        prompt: `${basePrompt}

Write:
- subject: short, mentions the folder and date range or count.
- body_text: clean plain-text version.
- body_html: well-structured HTML using headings, bullet lists, and bold for emphasis. Use simple inline styles only. No <html>, <head>, or <body> tags — just the inner content. Do not include images.

Be concise. Skip empty/duplicate content. If there are no emails, say so briefly.`,
      }),
      90_000,
      "summarizeFolderEmails(primary)",
    );
    return output;
  } catch (err: unknown) {
    console.warn(
      "summarizeFolderEmails: structured output failed, falling back to plain text:",
      err instanceof Error ? err.message : err,
    );
  }

  // Fallback: plain Markdown, then convert to text/html.
  const { text } = await withTimeout(
    generateText({
      model: getModel(PRIMARY_MODEL),
      prompt: `${basePrompt}

Write a daily digest in Markdown. Start with a single line: "# <short subject>" — that first line is the email subject. Then group by sender or topic, surface action items, keep it scannable. No images.`,
    }),
    90_000,
    "summarizeFolderEmails(fallback)",
  );

  const lines = text.split("\n");
  let subject = `${args.folderName} daily digest`;
  let bodyMd = text;
  const firstHeading = lines.findIndex((l) => l.trim().startsWith("#"));
  if (firstHeading >= 0) {
    subject =
      lines[firstHeading]
        .replace(/^#+\s*/, "")
        .trim()
        .slice(0, 200) || subject;
    bodyMd = lines
      .slice(firstHeading + 1)
      .join("\n")
      .trim();
  }

  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const html = bodyMd
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (/^#{1,6}\s/.test(trimmed)) {
        const m = trimmed.match(/^(#{1,6})\s+(.*)$/);
        if (m) {
          const level = Math.min(m[1].length + 1, 6);
          return `<h${level} style="margin:16px 0 8px">${escapeHtml(m[2])}</h${level}>`;
        }
      }
      if (/^[-*]\s/.test(trimmed)) {
        const items = trimmed
          .split("\n")
          .filter((l) => /^[-*]\s/.test(l))
          .map((l) => `<li>${escapeHtml(l.replace(/^[-*]\s+/, ""))}</li>`)
          .join("");
        return `<ul style="margin:8px 0 8px 20px">${items}</ul>`;
      }
      return `<p style="margin:8px 0">${escapeHtml(trimmed).replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  return {
    subject,
    body_text: bodyMd,
    body_html: html,
    _fallback: true,
  };
}

// Turn a plain-language description of a folder's purpose into a concise,
// classifier-friendly AI rule. Used by the folder editor's "generate from
// purpose" helper. Returns a short rule string.
export async function generateAiRuleFromPurpose(opts: {
  purpose: string;
  folderName?: string;
}): Promise<string> {
  const purpose = opts.purpose.trim();
  if (!purpose) throw new Error("Describe the folder's purpose first.");

  const prompt = `You write concise classification rules that an email assistant uses to decide whether an incoming email belongs in a specific folder.

${opts.folderName ? `Folder name: "${opts.folderName}"\n` : ""}The user describes the folder's purpose like this:
"${purpose}"

Write a single, clear rule (1-2 sentences, plain text, no markdown, no quotes, no preamble) describing the kinds of emails that belong in this folder. Be specific about senders, topics, and signals (e.g. mention concrete services or keywords the user named). Do not add anything beyond the rule itself.`;

  const { text } = await generateText({
    model: getModel("google/gemini-2.5-flash"),
    prompt,
  });

  const cleaned = text
    .trim()
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();

  if (!cleaned) throw new Error("AI returned an empty rule. Try rephrasing the purpose.");
  return cleaned.slice(0, 600);
}
