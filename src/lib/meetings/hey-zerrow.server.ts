// "Hey Zerrow" in-meeting Q&A. Answers questions in the meeting chat, grounded
// strictly in the live transcript buffer for the current bot. Server-only.
import { generateText } from "ai";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway";
import { logError, logInfo } from "@/lib/log.server";
import { sendBotChatMessage } from "@/lib/recall.server";

const MODEL = "google/gemini-3.5-flash";
const CONTEXT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ANSWER_WORDS = 60;

export type TranscriptSeg = { t: number; s: string | null; w: string };

type BufferRow = {
  meeting_id: string | null;
  user_id: string;
  segments: TranscriptSeg[] | null;
  last_trigger_at: string | null;
};

export type AskTriggerSource = "voice" | "chat";

export async function askZerrowInMeeting(input: {
  botId: string;
  question: string;
  source: AskTriggerSource;
  asker?: string | null;
}): Promise<void> {
  const started = Date.now();
  const { botId, question, source, asker } = input;

  const { data: buffer } = await supabaseAdmin
    .from("meeting_transcript_buffer")
    .select("meeting_id, user_id, segments, last_trigger_at")
    .eq("bot_id", botId)
    .maybeSingle<BufferRow>();

  if (!buffer) {
    logInfo("hey_zerrow_no_buffer", { botId });
    return;
  }

  // Debounce 4s per bot: voice + chat commonly fire in quick succession.
  if (buffer.last_trigger_at) {
    const gap = Date.now() - new Date(buffer.last_trigger_at).getTime();
    if (gap < 4000) return;
  }
  await supabaseAdmin
    .from("meeting_transcript_buffer")
    .update({ last_trigger_at: new Date().toISOString() })
    .eq("bot_id", botId);

  const cutoff = Date.now() - CONTEXT_WINDOW_MS;
  const recent = (buffer.segments ?? []).filter((s) => s.t >= cutoff);
  const transcript = recent
    .map((s) => `${s.s ? `${s.s}: ` : ""}${s.w}`)
    .join("\n")
    .slice(-8000);

  let answer: string;
  let error: string | null = null;
  try {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY missing");
    const gateway = createLovableAiGatewayProvider(apiKey);
    const result = await generateText({
      model: gateway(MODEL),
      messages: [
        {
          role: "system",
          content: [
            "You are Zerrow, an assistant listening to the current meeting.",
            `Answer briefly (at most ${MAX_ANSWER_WORDS} words) using ONLY the transcript below.`,
            "If the transcript does not contain the answer, say so plainly.",
            "Do not invent facts, participants, or decisions.",
            "",
            "TRANSCRIPT (recent, speaker: text):",
            transcript || "(no transcript captured yet)",
          ].join("\n"),
        },
        { role: "user", content: question.slice(0, 500) },
      ],
    });
    answer = result.text.trim() || "I couldn't find an answer in the transcript.";
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    answer = "Sorry — I couldn't answer that. Try again in a moment.";
    logError("hey_zerrow_llm_failed", { botId, err: error });
  }

  const reply = `Zerrow: ${answer}`.slice(0, 1000);
  try {
    await sendBotChatMessage(botId, reply);
  } catch (e) {
    logError("hey_zerrow_send_failed", {
      botId,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  await supabaseAdmin.from("meeting_qa").insert({
    bot_id: botId,
    meeting_id: buffer.meeting_id,
    user_id: buffer.user_id,
    trigger_source: source,
    asker: asker ?? null,
    question: question.slice(0, 1000),
    answer: answer.slice(0, 2000),
    latency_ms: Date.now() - started,
    error,
  });
}

/**
 * Append transcript words to the rolling buffer for a bot and return the
 * updated segment list. Keeps only the last CONTEXT_WINDOW_MS of segments.
 */
export async function appendTranscriptSegments(
  botId: string,
  incoming: TranscriptSeg[],
): Promise<void> {
  if (!incoming.length) return;
  const { data: existing } = await supabaseAdmin
    .from("meeting_transcript_buffer")
    .select("segments")
    .eq("bot_id", botId)
    .maybeSingle<{ segments: TranscriptSeg[] | null }>();

  if (!existing) return; // buffer must be provisioned by caller first
  const cutoff = Date.now() - CONTEXT_WINDOW_MS;
  const merged = [...(existing.segments ?? []), ...incoming]
    .filter((s) => s.t >= cutoff)
    .slice(-1500);

  await supabaseAdmin
    .from("meeting_transcript_buffer")
    .update({ segments: merged, updated_at: new Date().toISOString() })
    .eq("bot_id", botId);
}

/** Ensure a buffer row exists for the given bot, linked to the meeting/user. */
export async function ensureTranscriptBuffer(botId: string): Promise<{
  meeting_id: string | null;
  user_id: string;
} | null> {
  const { data: existing } = await supabaseAdmin
    .from("meeting_transcript_buffer")
    .select("meeting_id, user_id")
    .eq("bot_id", botId)
    .maybeSingle();
  if (existing) return existing;

  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id, user_id")
    .eq("recall_bot_id", botId)
    .maybeSingle();
  if (!meeting) return null;

  await supabaseAdmin.from("meeting_transcript_buffer").insert({
    bot_id: botId,
    meeting_id: meeting.id,
    user_id: meeting.user_id,
    segments: [],
  });
  return { meeting_id: meeting.id, user_id: meeting.user_id };
}
