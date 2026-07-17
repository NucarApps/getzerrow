// Scan recent Sent emails and flag open tasks that look done, without
// auto-completing them. UI shows an amber "looks done — confirm?" chip.
import { generateText } from "ai";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway";
import { logError, logInfo } from "@/lib/log.server";

const MODEL = "google/gemini-3.5-flash";
const LOOKBACK_HOURS = 24;

const MatchSchema = z.object({
  matches: z
    .array(
      z.object({
        task_id: z.string().uuid(),
        confidence: z.enum(["high", "med", "low"]),
        reasoning: z.string().max(300),
      }),
    )
    .max(20),
});

type OpenTask = {
  id: string;
  title: string;
  notes: string | null;
  source: string;
};
type SentEmail = {
  id: string;
  subject: string | null;
  snippet: string | null;
  to_addrs: string | null;
  from_addr: string | null;
  received_at: string | null;
};

/** For a single user, correlate their open tasks with recent Sent items. */
async function scanUser(userId: string): Promise<number> {
  const { data: tasks } = await supabaseAdmin
    .from("tasks")
    .select("id, title, notes, source")
    .eq("user_id", userId)
    .eq("status", "open")
    .limit(80);
  if (!tasks || tasks.length === 0) return 0;

  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const { data: sent } = await supabaseAdmin
    .from("emails")
    .select("id, subject, snippet, to_addrs, from_addr, received_at, raw_labels")
    .eq("user_id", userId)
    .contains("raw_labels", ["SENT"])
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(40);
  if (!sent || sent.length === 0) return 0;

  // Skip pairs we've already scored.
  const { data: existingRows } = await supabaseAdmin
    .from("task_completion_suggestions")
    .select("task_id, sent_email_id")
    .eq("user_id", userId)
    .in(
      "task_id",
      tasks.map((t) => t.id),
    );
  const seen = new Set((existingRows ?? []).map((r) => `${r.task_id}::${r.sent_email_id}`));

  let inserted = 0;
  for (const email of sent as SentEmail[]) {
    // Ask the model which of the user's open tasks this sent email likely fulfills.
    const candidates = (tasks as OpenTask[]).filter(
      (t) => !seen.has(`${t.id}::${email.id}`),
    );
    if (candidates.length === 0) continue;

    const system = [
      "You decide whether a SENT email fulfills any of the user's OPEN tasks.",
      "Only flag a task when the email clearly delivers, replies to, or confirms it.",
      "Prefer NO match over a shaky one; low-confidence matches waste the user's time.",
      "",
      'Reply with STRICT JSON: {"matches":[{"task_id":uuid,"confidence":"high"|"med"|"low","reasoning":string}]}',
      "Return empty matches if no task is fulfilled.",
    ].join("\n");
    const user = [
      `SENT EMAIL:`,
      `To: ${email.to_addrs ?? ""}`,
      `Subject: ${email.subject ?? ""}`,
      `Snippet: ${email.snippet ?? ""}`,
      ``,
      `OPEN TASKS:`,
      ...candidates.map((t) => `- id=${t.id} | ${t.title}${t.notes ? ` — ${t.notes.slice(0, 200)}` : ""}`),
    ].join("\n");

    let parsed: z.infer<typeof MatchSchema>;
    try {
      const apiKey = process.env.LOVABLE_API_KEY;
      if (!apiKey) throw new Error("LOVABLE_API_KEY missing");
      const gateway = createLovableAiGatewayProvider(apiKey);
      const { text } = await generateText({
        model: gateway(MODEL),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user.slice(0, 8000) },
        ],
      });
      const cleaned = text
        .trim()
        .replace(/^```json\n?/i, "")
        .replace(/^```\n?/, "")
        .replace(/```$/, "");
      parsed = MatchSchema.parse(JSON.parse(cleaned));
    } catch (e) {
      logError("tasks_completion_llm_failed", { userId, emailId: email.id }, e);
      continue;
    }

    for (const m of parsed.matches) {
      // Guard: model can only match tasks we sent it.
      if (!candidates.some((c) => c.id === m.task_id)) continue;
      const { error } = await supabaseAdmin.from("task_completion_suggestions").insert({
        user_id: userId,
        task_id: m.task_id,
        sent_email_id: email.id,
        confidence: m.confidence,
        reasoning: m.reasoning,
      });
      if (!error) inserted++;
    }
  }
  logInfo("tasks_completion_scan_user", { userId, inserted, sent: sent.length });
  return inserted;
}

/** Cron entry: scan every user with recent sent activity. */
export async function scanSentForTaskCompletion(): Promise<{ users: number; inserted: number }> {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const { data: users } = await supabaseAdmin
    .from("emails")
    .select("user_id")
    .contains("raw_labels", ["SENT"])
    .gte("received_at", since)
    .limit(2000);
  const unique = Array.from(new Set((users ?? []).map((r) => r.user_id as string)));
  let inserted = 0;
  for (const uid of unique) {
    try {
      inserted += await scanUser(uid);
    } catch (e) {
      logError("tasks_completion_scan_user_failed", { userId: uid }, e);
    }
  }
  return { users: unique.length, inserted };
}
