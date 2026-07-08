// Server-only helpers for the Meetings feature: finalizing a completed
// Recall bot (recording + transcript + summary), and linking meeting
// participants to existing CRM contacts. Uses the service-role client because
// it runs from the Recall webhook and cron reconcile — both unauthenticated
// contexts that must still write user-scoped rows safely (all writes are
// keyed by the meeting's own user_id).
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { logError } from "./log.server";
import { collapseRunawayRepeats } from "./transcript-sanitize";

type MeetingUpdate = Database["public"]["Tables"]["meetings"]["Update"];
import {
  getBot,
  getTranscript,
  extractRecordingUrl,
  extractParticipantEmails,
  latestStatusCode,
  leaveBot,
  summarizeTranscript,
  type RecallBot,
  type TranscriptSegment,
} from "./recall.server";

const TERMINAL_CODES = new Set(["done", "fatal", "call_ended", "recording_done"]);
const FAILED_CODES = new Set(["fatal", "call_not_started", "timeout"]);

/** Map a Recall status code to our meeting_status enum. */
export function mapStatus(
  code: string | null,
): "scheduled" | "joining" | "recording" | "done" | "failed" {
  if (!code) return "scheduled";
  if (FAILED_CODES.has(code)) return "failed";
  if (code === "done" || code === "recording_done" || code === "call_ended") return "done";
  if (code === "in_call_recording" || code === "recording") return "recording";
  if (code === "joining_call" || code === "in_waiting_room" || code === "in_call_not_recording")
    return "joining";
  return "scheduled";
}

type MeetingRow = {
  id: string;
  user_id: string;
  recall_bot_id: string | null;
  status: string;
  title: string | null;
};

/** The generic placeholder used when an in-person meeting is created without a title. */
const IN_PERSON_TITLE = "In-person meeting";

/** True when a meeting has no meaningful, user-provided title yet. */
function needsAutoTitle(title: string | null | undefined): boolean {
  const t = title?.trim();
  return !t || t === IN_PERSON_TITLE;
}

/**
 * Generate a short, descriptive meeting title from its summary or transcript.
 * Best-effort: returns null on any failure (missing key, AI error) so it never
 * blocks finalizing a meeting.
 */
export async function generateMeetingTitle(sourceText: string): Promise<string | null> {
  const apiKey = process.env.LOVABLE_API_KEY;
  const text = sourceText.trim();
  if (!apiKey || !text) return null;
  try {
    const { generateText } = await import("ai");
    const { createLovableAiGatewayProvider } = await import("./ai-gateway");
    const model = createLovableAiGatewayProvider(apiKey)(SUMMARY_MODEL);
    const { text: raw } = await generateText({
      model,
      messages: [
        {
          role: "system",
          content:
            "You write concise meeting titles. Given a meeting summary or transcript, reply with a single specific title of at most 8 words in sentence case. No quotes, no trailing punctuation, no preamble.",
        },
        { role: "user", content: text.slice(0, 8000) },
      ],
    });
    const cleaned = raw
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/[.]+$/, "")
      .trim();
    return cleaned ? cleaned.slice(0, 120) : null;
  } catch (e) {
    logError("meeting_title_generate_failed", {}, e);
    return null;
  }
}

/** System prompt for the AI-written meeting breakdown (markdown output). */
const BREAKDOWN_SYSTEM_PROMPT =
  "You analyze meeting transcripts and write detailed breakdowns in markdown. " +
  "Use exactly these '## ' sections in this order: Overview, Topics discussed, Key decisions, Action items, Notable moments. " +
  "Overview: 2-4 sentences on what the meeting was about and its outcome. " +
  "Topics discussed: a '### ' subheading per topic followed by a detailed explanation of what was said, naming who said it whenever speaker names appear. " +
  "Key decisions, Action items (with owners when clear), and Notable moments: '- ' bullets; if a section truly has nothing, use a single bullet '- None noted.' " +
  "Start directly with '## Overview'. No preamble, no code fences.";

/** True when a stored summary is a real AI breakdown (not the old digest). */
export function isBreakdownSummary(summary: string | null | undefined): boolean {
  return !!summary && summary.includes("## Overview");
}

/** Join transcript segments into speaker-prefixed lines for the AI breakdown. */
export function transcriptSegmentsToText(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => {
      const text = s.text.trim();
      return s.speaker ? `${s.speaker}: ${text}` : text;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Produce a detailed, AI-written markdown breakdown of a meeting from its
 * speaker-prefixed transcript text. Best-effort: returns null on any failure
 * (missing key, empty text, AI error) so callers can fall back to the compact
 * extractive digest (summarizeTranscript).
 */
export async function generateMeetingBreakdown(transcriptText: string): Promise<string | null> {
  const apiKey = process.env.LOVABLE_API_KEY;
  const text = transcriptText.trim();
  if (!apiKey || !text) return null;
  try {
    const { generateText } = await import("ai");
    const { createLovableAiGatewayProvider } = await import("./ai-gateway");
    const model = createLovableAiGatewayProvider(apiKey)(SUMMARY_MODEL);
    const { text: raw } = await generateText({
      model,
      messages: [
        { role: "system", content: BREAKDOWN_SYSTEM_PROMPT },
        { role: "user", content: text.slice(0, 24000) },
      ],
    });
    const cleaned = raw.trim();
    return cleaned || null;
  } catch (e) {
    logError("meeting_breakdown_failed", {}, e);
    return null;
  }
}

export const DEFAULT_BOT_NAME = "Zerrow Notetaker";
const AVATAR_BUCKET = "meeting-bot-avatars";

/** Resolved notetaker bot customization for a given user. */
export type BotConfig = {
  botName: string;
  chatMessage: string | null;
  chatResendOnJoin: boolean;
  imageB64: string | null;
};

/**
 * Load a user's meeting-bot customization (name, chat message, picture) so the
 * same settings apply to every bot we create for them — whether from a pasted
 * link or calendar auto-join. Uses the service-role client because it runs from
 * both authenticated and unauthenticated (cron) contexts; all reads are keyed
 * by the passed userId. Never throws: falls back to sensible defaults so a bad
 * settings row or missing picture can't block a recording from starting.
 */
export async function loadBotConfig(userId: string): Promise<BotConfig> {
  const fallback: BotConfig = {
    botName: DEFAULT_BOT_NAME,
    chatMessage: null,
    chatResendOnJoin: true,
    imageB64: null,
  };
  try {
    const { data: row } = await supabaseAdmin
      .from("meeting_bot_settings")
      .select("bot_name, chat_message, chat_resend_on_join, avatar_updated_at")
      .eq("user_id", userId)
      .maybeSingle();

    const botName = row?.bot_name?.trim() || DEFAULT_BOT_NAME;
    const chatMessage = row?.chat_message?.trim() ? row.chat_message.trim() : null;
    const chatResendOnJoin = row?.chat_resend_on_join ?? true;

    let imageB64: string | null = null;
    if (row?.avatar_updated_at) {
      try {
        const { data: file } = await supabaseAdmin.storage
          .from(AVATAR_BUCKET)
          .download(`${userId}/avatar.jpg`);
        if (file) {
          const buf = Buffer.from(await file.arrayBuffer());
          imageB64 = buf.toString("base64");
        }
      } catch (e) {
        logError("meeting_bot_avatar_download_failed", { userId }, e);
      }
    }

    return { botName, chatMessage, chatResendOnJoin, imageB64 };
  } catch (e) {
    logError("meeting_bot_config_load_failed", { userId }, e);
    return fallback;
  }
}

/**
 * Match a meeting's participants (from meeting_participants.email) to existing
 * contacts owned by the same user and populate contact_id. Idempotent.
 */
export async function linkParticipantsToContacts(meetingId: string, userId: string): Promise<void> {
  const { data: parts } = await supabaseAdmin
    .from("meeting_participants")
    .select("id, email, contact_id")
    .eq("meeting_id", meetingId);
  if (!parts?.length) return;

  const unlinked = parts.filter((p) => !p.contact_id && p.email);
  if (!unlinked.length) return;

  const emails = [...new Set(unlinked.map((p) => (p.email as string).toLowerCase()))];
  const { data: contacts } = await supabaseAdmin
    .from("contacts")
    .select("id, email")
    .eq("user_id", userId)
    .in("email", emails);
  if (!contacts?.length) return;

  const byEmail = new Map(contacts.map((c) => [(c.email as string).toLowerCase(), c.id]));
  for (const p of unlinked) {
    const contactId = byEmail.get((p.email as string).toLowerCase());
    if (contactId) {
      await supabaseAdmin
        .from("meeting_participants")
        .update({ contact_id: contactId })
        .eq("id", p.id);
    }
  }
}

/**
 * Pull the latest state for one meeting from Recall and persist it. When the
 * bot has finished, stores the recording URL, transcript, and summary, and
 * links participants to contacts. Returns the resolved status.
 */
export async function syncMeetingFromRecall(meeting: MeetingRow): Promise<string> {
  if (!meeting.recall_bot_id) return meeting.status;

  let bot: RecallBot;
  try {
    bot = await getBot(meeting.recall_bot_id);
  } catch (e) {
    logError("meeting_sync_getbot_failed", { meetingId: meeting.id }, e);
    return meeting.status;
  }

  const code = latestStatusCode(bot);
  const status = mapStatus(code);

  // Safety net: if a blocked person's email shows up in the meeting's
  // participants once the bot is in the call, pull the bot out and discard the
  // recording instead of saving it. Emails are often absent from meeting
  // platforms, so this is best-effort on top of the calendar-based check.
  if (status === "recording" || status === "done") {
    try {
      const emails = extractParticipantEmails(bot);
      const { findBlockedEmailForUser } = await import("./meetings-autojoin.server");
      const blocked = await findBlockedEmailForUser(meeting.user_id, emails);
      if (blocked) {
        await leaveBot(meeting.recall_bot_id);
        await supabaseAdmin
          .from("meetings")
          .update({
            status: "failed",
            error: "Recording stopped — a blocked person was in the meeting.",
            ended_at: new Date().toISOString(),
          })
          .eq("id", meeting.id);
        return "failed";
      }
    } catch (e) {
      logError("meeting_sync_blocklist_failed", { meetingId: meeting.id }, e);
    }
  }

  const update: MeetingUpdate = { status };

  if (status === "recording" || status === "done") {
    // best-effort recording link
    const url = extractRecordingUrl(bot);
    if (url) update.recording_url = url;
  }

  if (status === "done") {
    update.ended_at = new Date().toISOString();
    try {
      const segments = await getTranscript(bot);
      if (segments.length) {
        update.transcript = segments as unknown as MeetingUpdate["transcript"];
        const breakdown = await generateMeetingBreakdown(transcriptSegmentsToText(segments));
        update.summary = breakdown ?? summarizeTranscript(segments);
        if (needsAutoTitle(meeting.title)) {
          const generated = await generateMeetingTitle(
            update.summary || segments.map((s) => s.text).join(" "),
          );
          if (generated) update.title = generated;
        }
      }
    } catch (e) {
      logError("meeting_sync_transcript_failed", { meetingId: meeting.id }, e);
    }
  }

  if (status === "failed") {
    update.error =
      bot.status_changes?.find((c) => FAILED_CODES.has(c.code))?.message ?? "Bot failed";
  }

  const { error } = await supabaseAdmin.from("meetings").update(update).eq("id", meeting.id);
  if (error)
    logError("meeting_sync_update_failed", { meetingId: meeting.id, error: error.message });

  if (status === "done") {
    await linkParticipantsToContacts(meeting.id, meeting.user_id);
  }

  return status;
}

/** Whether a status is terminal (no further polling needed). */
export function isTerminalCode(code: string | null): boolean {
  return code ? TERMINAL_CODES.has(code) : false;
}

/**
 * Resolve a playable recording URL for the streaming proxy hot path. Kept
 * deliberately cheap: it reads the stored `recording_url` and returns it
 * without touching transcripts, summaries, or writing rows. Only when there is
 * no stored URL at all does it call Recall once to mint (and persist) a fresh
 * signed S3 URL. This is what every byte-range request from the <video> element
 * hits, so it must never do per-request Recall/transcript work.
 */
export type PlayableRecording = {
  url: string | null;
  recallBotId: string | null;
  contentType: string;
  filename: string;
};

function extensionFor(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "mp4";
}

function audioContentTypeFor(path: string): string {
  const ext = extensionFor(path);
  switch (ext) {
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "ogg":
      return "audio/ogg";
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "webm":
      return "audio/webm";
    default:
      return "application/octet-stream";
  }
}

function videoContentTypeFor(path: string): string {
  const ext = extensionFor(path);
  switch (ext) {
    case "webm":
      return "video/webm";
    case "mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

async function signedStoredRecordingUrl(path: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.storage
    .from(RECORDINGS_BUCKET)
    .createSignedUrl(path, 60 * 60 * 2);
  if (error) return null;
  return data?.signedUrl ?? null;
}

export async function resolvePlayableRecordingUrl(meetingId: string): Promise<PlayableRecording> {
  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id, recall_bot_id, recording_url, audio_storage_path, video_storage_path")
    .eq("id", meetingId)
    .maybeSingle();
  if (!meeting) {
    return {
      url: null,
      recallBotId: null,
      contentType: "video/mp4",
      filename: `recording-${meetingId}.mp4`,
    };
  }
  if (meeting.video_storage_path) {
    const ext = extensionFor(meeting.video_storage_path);
    return {
      url: await signedStoredRecordingUrl(meeting.video_storage_path),
      recallBotId: null,
      contentType: videoContentTypeFor(meeting.video_storage_path),
      filename: `recording-${meetingId}.${ext}`,
    };
  }
  if (meeting.audio_storage_path) {
    const ext = extensionFor(meeting.audio_storage_path);
    return {
      url: await signedStoredRecordingUrl(meeting.audio_storage_path),
      recallBotId: null,
      contentType: audioContentTypeFor(meeting.audio_storage_path),
      filename: `recording-${meetingId}.${ext}`,
    };
  }
  const recallBotId = meeting.recall_bot_id ?? null;
  if (meeting.recording_url) {
    return {
      url: meeting.recording_url,
      recallBotId,
      contentType: "video/mp4",
      filename: `recording-${meetingId}.mp4`,
    };
  }
  if (!recallBotId) {
    return {
      url: null,
      recallBotId: null,
      contentType: "video/mp4",
      filename: `recording-${meetingId}.mp4`,
    };
  }
  return {
    url: await mintFreshRecordingUrl(meeting.id, recallBotId),
    recallBotId,
    contentType: "video/mp4",
    filename: `recording-${meetingId}.mp4`,
  };
}

/**
 * Fetch a fresh signed recording URL from Recall for one meeting and persist
 * it. No transcript/summary work. Used both when no URL is stored yet and as a
 * one-shot recovery when a stored URL has expired mid-playback.
 */
export async function mintFreshRecordingUrl(
  meetingId: string,
  recallBotId: string,
): Promise<string | null> {
  let bot: RecallBot;
  try {
    bot = await getBot(recallBotId);
  } catch (e) {
    logError("meeting_mint_getbot_failed", { meetingId }, e);
    return null;
  }
  const url = extractRecordingUrl(bot);
  if (!url) return null;
  const { error } = await supabaseAdmin
    .from("meetings")
    .update({ recording_url: url })
    .eq("id", meetingId);
  if (error) logError("meeting_mint_update_failed", { meetingId, error: error.message });
  return url;
}

/**
 * For an already-finished meeting, pull a *fresh* signed recording URL from
 * Recall (the stored one is short-lived and expires), and backfill the
 * transcript/summary if they never landed. Does not change the meeting status.
 * Returns the fresh recording URL (or the stored one when Recall has none yet).
 */
export async function refreshMeetingRecording(meetingId: string): Promise<{
  recordingUrl: string | null;
  hasRecording: boolean;
  hasTranscript: boolean;
  hasSummary: boolean;
}> {
  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id, user_id, recall_bot_id, recording_url, transcript, summary")
    .eq("id", meetingId)
    .maybeSingle();
  if (!meeting?.recall_bot_id) {
    return {
      recordingUrl: meeting?.recording_url ?? null,
      hasRecording: !!meeting?.recording_url,
      hasTranscript: !!meeting?.transcript,
      hasSummary: !!meeting?.summary,
    };
  }

  let bot: RecallBot;
  try {
    bot = await getBot(meeting.recall_bot_id);
  } catch (e) {
    logError("meeting_refresh_getbot_failed", { meetingId }, e);
    return {
      recordingUrl: meeting.recording_url ?? null,
      hasRecording: !!meeting.recording_url,
      hasTranscript: !!meeting.transcript,
      hasSummary: !!meeting.summary,
    };
  }

  const update: MeetingUpdate = {};
  const freshUrl = extractRecordingUrl(bot);
  if (freshUrl) update.recording_url = freshUrl;
  let hasTranscript = !!meeting.transcript;
  let hasSummary = !!meeting.summary;

  // Backfill transcript/summary if they never landed, and upgrade an old
  // extractive digest (no "## Overview") to a real AI breakdown.
  const needsBackfill = !meeting.transcript || !meeting.summary;
  const needsSummaryUpgrade =
    !!meeting.transcript && !!meeting.summary && !isBreakdownSummary(meeting.summary);
  if (needsBackfill || needsSummaryUpgrade) {
    try {
      const segments = await getTranscript(bot);
      if (segments.length) {
        if (!meeting.transcript) {
          update.transcript = segments as unknown as MeetingUpdate["transcript"];
          hasTranscript = true;
        }
        if (!meeting.summary) {
          const breakdown = await generateMeetingBreakdown(transcriptSegmentsToText(segments));
          const newSummary = breakdown ?? summarizeTranscript(segments);
          if (newSummary) {
            update.summary = newSummary;
            hasSummary = true;
          }
        } else if (!isBreakdownSummary(meeting.summary)) {
          // Only overwrite the old digest when the AI breakdown succeeds.
          const breakdown = await generateMeetingBreakdown(transcriptSegmentsToText(segments));
          if (breakdown) {
            update.summary = breakdown;
            hasSummary = true;
          }
        }
      }
    } catch (e) {
      logError("meeting_refresh_transcript_failed", { meetingId }, e);
    }
  }

  if (Object.keys(update).length > 0) {
    const { error } = await supabaseAdmin.from("meetings").update(update).eq("id", meetingId);
    if (error) logError("meeting_refresh_update_failed", { meetingId, error: error.message });
    if (update.transcript) {
      await linkParticipantsToContacts(meetingId, meeting.user_id);
    }
  }

  const recordingUrl = freshUrl ?? meeting.recording_url ?? null;
  return {
    recordingUrl,
    hasRecording: !!recordingUrl,
    hasTranscript,
    hasSummary,
  };
}

const AI_GATEWAY_BASE = "https://ai.gateway.lovable.dev/v1";
const STT_MODEL = "openai/gpt-4o-mini-transcribe";
const SUMMARY_MODEL = "google/gemini-3-flash-preview";
const RECORDINGS_BUCKET = "meeting-recordings";

/** Best-effort MIME type from the stored audio file extension. */
function audioMimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "ogg":
      return "audio/ogg";
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    default:
      return "audio/webm";
  }
}

/**
 * Transcribe an in-person recording via the Lovable AI speech-to-text endpoint
 * and generate a short summary, then write both to the meeting row. Downloads
 * the audio with the service-role client (it may run from an auth'd server fn,
 * but keeping storage access here avoids leaking the path handling into the
 * client bundle). On any failure the meeting is flagged `failed` with a
 * friendly message so the UI never gets stuck on "processing".
 */
export async function finalizeInPersonMeeting(meetingId: string): Promise<string> {
  const apiKey = process.env.LOVABLE_API_KEY;

  const fail = async (message: string, e?: unknown): Promise<string> => {
    logError("meeting_in_person_finalize_failed", { meetingId, message }, e);
    await supabaseAdmin
      .from("meetings")
      .update({ status: "failed", error: message, ended_at: new Date().toISOString() })
      .eq("id", meetingId);
    return "failed";
  };

  if (!apiKey) return fail("Transcription is not configured.");

  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id, user_id, audio_storage_path, title")
    .eq("id", meetingId)
    .maybeSingle();
  if (!meeting?.audio_storage_path) return fail("Recording file is missing.");

  // Download the uploaded audio from storage.
  let audioBlob: Blob;
  try {
    const { data: file, error } = await supabaseAdmin.storage
      .from(RECORDINGS_BUCKET)
      .download(meeting.audio_storage_path);
    if (error || !file) throw error ?? new Error("empty download");
    audioBlob = file;
  } catch (e) {
    return fail("Could not read the recording.", e);
  }

  // Transcribe (multipart/form-data to the OpenAI-compatible endpoint).
  let transcriptText: string;
  try {
    const mime = audioMimeFor(meeting.audio_storage_path);
    const form = new FormData();
    form.append("model", STT_MODEL);
    form.append(
      "file",
      new File([audioBlob], meeting.audio_storage_path.split("/").pop() ?? "audio.webm", {
        type: mime,
      }),
    );
    const res = await fetch(`${AI_GATEWAY_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { "Lovable-API-Key": apiKey },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return fail("Could not transcribe the recording.", `${res.status}: ${body}`);
    }
    const json = (await res.json()) as { text?: string };
    transcriptText = collapseRunawayRepeats((json.text ?? "").trim());
  } catch (e) {
    return fail("Could not transcribe the recording.", e);
  }

  if (!transcriptText) {
    return fail("No speech was detected in the recording.");
  }

  // Store the transcript in the same shape the detail view already renders.
  const segments: TranscriptSegment[] = [{ speaker: null, text: transcriptText, start: 0 }];

  // Summarize with the default chat model, matching the "Key moments" style.
  let summary: string | null;
  try {
    const { generateText } = await import("ai");
    const { createLovableAiGatewayProvider } = await import("./ai-gateway");
    const model = createLovableAiGatewayProvider(apiKey)(SUMMARY_MODEL);
    const { text } = await generateText({
      model,
      messages: [
        {
          role: "system",
          content:
            "You summarize meeting transcripts. Reply with a heading line 'Key moments' followed by 3-6 concise bullet points starting with '• '. No preamble.",
        },
        { role: "user", content: transcriptText.slice(0, 24000) },
      ],
    });
    summary = text.trim() || null;
  } catch (e) {
    logError("meeting_in_person_summary_failed", { meetingId }, e);
    summary = summarizeTranscript(segments);
  }

  const update: MeetingUpdate = {
    transcript: segments as unknown as MeetingUpdate["transcript"],
    summary,
    status: "done",
    ended_at: new Date().toISOString(),
  };
  if (needsAutoTitle(meeting.title)) {
    const generated = await generateMeetingTitle(summary || transcriptText);
    if (generated) update.title = generated;
  }

  const { error } = await supabaseAdmin.from("meetings").update(update).eq("id", meetingId);
  if (error) return fail("Could not save the transcript.", error.message);

  return "done";
}
