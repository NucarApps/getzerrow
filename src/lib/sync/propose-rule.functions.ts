// proposeRuleFromEmail server fn (rules upgrade, task 11): decrypts one
// email the caller owns, asks the gateway (timeboxed) for a folder +
// rule-tree proposal, Zod-validates the untrusted reply, and falls back
// to a deterministic domain rule on any violation.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getEmailsDecrypted } from "./encrypted-reader";
import { AI_CLASSIFY_ATTEMPT_TIMEOUT_MS } from "./config";
import {
  parseProposal,
  buildFallbackProposal,
  PROPOSABLE_ACTIONS,
  type RuleProposal,
} from "./propose-rule";
import { sanitizeUntrustedText, UNTRUSTED_BOUNDARY_INSTRUCTION } from "../ai-untrusted";

const FIELDS = "from, domain, subject, body, to, cc, list_id";
const OPS = "contains, not_contains, equals, not_equals, starts_with, ends_with";

async function askModel(prompt: string): Promise<string> {
  const { generateText } = await import("ai");
  const { getModel } = await import("../ai-gateway");
  const model = getModel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<string>([
      generateText({ model, prompt }).then((r) => r.text),
      new Promise<string>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("rule proposal timed out")),
          AI_CLASSIFY_ATTEMPT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const proposeRuleFromEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email_id: string; intent?: string }) =>
    z
      .object({
        email_id: z.string().uuid(),
        intent: z.string().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<RuleProposal & { account_id: string }> => {
    const { rows, error } = await getEmailsDecrypted([data.email_id]);
    if (error) throw new Error(error);
    const email = rows[0];
    if (!email || email.user_id !== context.userId) throw new Error("Email not found");

    const from = sanitizeUntrustedText(email.from_addr ?? "", 120).text;
    const fromName = sanitizeUntrustedText(email.from_name ?? "", 80).text;
    const subject = sanitizeUntrustedText(email.subject ?? "", 200).text;
    const snippet = sanitizeUntrustedText(email.snippet ?? email.body_text ?? "", 500).text;

    const prompt = [
      "Design an email sorting rule from ONE example email.",
      UNTRUSTED_BOUNDARY_INSTRUCTION,
      "",
      "Reply with ONLY a JSON object of this exact shape:",
      `{"suggested_folder_name": "<short name>", "filter_tree": <rule node>, "actions": [<zero or more of ${PROPOSABLE_ACTIONS.map((a) => `"${a}"`).join(", ")}>]}`,
      `A rule node is {"type":"cond","field":<one of: ${FIELDS}>,"op":<one of: ${OPS}>,"value":"<string>"} or {"type":"group","op":"and"|"or","children":[...]} (max depth 3).`,
      "Prefer a simple domain or sender rule that generalizes to future mail from this source.",
      data.intent ? `User intent: ${sanitizeUntrustedText(data.intent, 500).text}` : "",
      "",
      "<untrusted_email>",
      `From: ${fromName} <${from}>`,
      `Subject: ${subject}`,
      `Snippet: ${snippet}`,
      "</untrusted_email>",
    ]
      .filter(Boolean)
      .join("\n");

    let proposal: RuleProposal | null;
    try {
      proposal = parseProposal(await askModel(prompt));
    } catch {
      proposal = null; // timeout / gateway error → deterministic fallback
    }
    const result =
      proposal ?? buildFallbackProposal({ from_addr: email.from_addr, from_name: email.from_name });
    return { ...result, account_id: email.gmail_account_id };
  });
