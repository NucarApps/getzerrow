// AI-powered task extraction from meeting transcripts and emails.
// Server-only; called from meeting-completion path, email classify path,
// and manual "extract" server functions.
import { generateText } from "ai";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway";
import { logError, logInfo } from "@/lib/log.server";

const MODEL = "google/gemini-3.5-flash";

const ExtractedTaskSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().min(1).max(300),
        notes: z.string().max(1000).nullish(),
        snippet: z.string().max(500).nullish(),
      }),
    )
    .max(10),
});

async function callExtractor(
  system: string,
  user: string,
): Promise<z.infer<typeof ExtractedTaskSchema>> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY missing");
  const gateway = createLovableAiGatewayProvider(apiKey);
  const { text } = await generateText({
    model: gateway(MODEL),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user.slice(0, 12000) },
    ],
  });
  // Model asked to return raw JSON; be tolerant to fenced blocks.
  const cleaned = text
    .trim()
    .replace(/^```json\n?/i, "")
    .replace(/^```\n?/, "")
    .replace(/```$/, "");
  try {
    return ExtractedTaskSchema.parse(JSON.parse(cleaned));
  } catch {
    return { tasks: [] };
  }
}

async function claimRun(
  userId: string,
  sourceType: "meeting" | "email_in" | "email_out",
  sourceId: string,
): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("task_extraction_runs")
    .insert({ user_id: userId, source_type: sourceType, source_id: sourceId });
  if (error) {
    // Duplicate = we've already scanned this source.
    return false;
  }
  return true;
}

/** Extract tasks the USER personally committed to from a meeting transcript. */
export async function extractTasksFromMeetingTranscript(input: {
  userId: string;
  meetingId: string;
  transcriptText: string;
  userDisplayNames: string[]; // e.g. ["Alex Smith", "alex@…"]
}): Promise<number> {
  if (!input.transcriptText.trim()) return 0;
  if (!(await claimRun(input.userId, "meeting", input.meetingId))) return 0;

  const namesLine = input.userDisplayNames.filter(Boolean).join(", ") || "the user";
  const system = [
    "You extract action items from a meeting transcript.",
    `Only extract tasks that ${namesLine} personally committed to do or was directly asked to do and accepted.`,
    "IGNORE action items assigned to other participants.",
    "IGNORE vague statements, opinions, or general discussion.",
    "Each task must be concrete and start with an imperative verb.",
    "",
    'Reply with STRICT JSON: {"tasks":[{"title":string,"notes":string|null,"snippet":string|null}]}',
    "Return an empty array if nothing qualifies. Max 10 tasks.",
    "`snippet` is a short verbatim quote (<= 200 chars) that anchors the task in the transcript.",
  ].join("\n");

  let extracted: z.infer<typeof ExtractedTaskSchema>;
  try {
    extracted = await callExtractor(system, input.transcriptText);
  } catch (e) {
    logError("tasks_extract_meeting_failed", { meetingId: input.meetingId }, e);
    return 0;
  }
  if (!extracted.tasks.length) return 0;

  const rows = extracted.tasks.map((t) => ({
    user_id: input.userId,
    title: t.title,
    notes: t.notes ?? null,
    source: "meeting" as const,
    source_meeting_id: input.meetingId,
    source_snippet: t.snippet ?? null,
  }));
  const { error } = await supabaseAdmin.from("tasks").insert(rows);
  if (error) {
    logError("tasks_extract_meeting_insert_failed", {
      meetingId: input.meetingId,
      err: error.message,
    });
    return 0;
  }
  logInfo("tasks_extract_meeting_ok", { meetingId: input.meetingId, count: rows.length });
  return rows.length;
}
