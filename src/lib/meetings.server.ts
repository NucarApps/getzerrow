// Server-only helpers for the Meetings feature: finalizing a completed
// Recall bot (recording + transcript + summary), and linking meeting
// participants to existing CRM contacts. Uses the service-role client because
// it runs from the Recall webhook and cron reconcile — both unauthenticated
// contexts that must still write user-scoped rows safely (all writes are
// keyed by the meeting's own user_id).
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { logError } from "./log.server";

type MeetingUpdate = Database["public"]["Tables"]["meetings"]["Update"];
import {
  getBot,
  getTranscript,
  extractRecordingUrl,
  latestStatusCode,
  summarizeTranscript,
  type RecallBot,
} from "./recall.server";

const TERMINAL_CODES = new Set(["done", "fatal", "call_ended", "recording_done"]);
const FAILED_CODES = new Set(["fatal", "call_not_started", "timeout"]);

/** Map a Recall status code to our meeting_status enum. */
export function mapStatus(code: string | null): "scheduled" | "joining" | "recording" | "done" | "failed" {
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
};

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
  const update: MeetingUpdate = { status };

  if (status === "recording" || status === "done") {
    // best-effort recording link
    const url = extractRecordingUrl(bot);
    if (url) update.recording_url = url;
  }

  if (status === "done") {
    update.ended_at = new Date().toISOString();
    try {
      const segments = await getTranscript(meeting.recall_bot_id);
      if (segments.length) {
        update.transcript = segments as unknown as MeetingUpdate["transcript"];
        update.summary = summarizeTranscript(segments);
      }
    } catch (e) {
      logError("meeting_sync_transcript_failed", { meetingId: meeting.id }, e);
    }
  }

  if (status === "failed") {
    update.error = bot.status_changes?.find((c) => FAILED_CODES.has(c.code))?.message ?? "Bot failed";
  }

  const { error } = await supabaseAdmin.from("meetings").update(update).eq("id", meeting.id);
  if (error) logError("meeting_sync_update_failed", { meetingId: meeting.id, error: error.message });

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
 * For an already-finished meeting, pull a *fresh* signed recording URL from
 * Recall (the stored one is short-lived and expires), and backfill the
 * transcript/summary if they never landed. Does not change the meeting status.
 * Returns the fresh recording URL (or the stored one when Recall has none yet).
 */
export async function refreshMeetingRecording(
  meetingId: string,
): Promise<{
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

  // Backfill transcript/summary only if they never landed.
  if (!meeting.transcript || !meeting.summary) {
    try {
      const segments = await getTranscript(meeting.recall_bot_id);
      if (segments.length) {
        update.transcript = segments as unknown as MeetingUpdate["transcript"];
        update.summary = summarizeTranscript(segments);
        hasTranscript = true;
        hasSummary = !!update.summary;
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
