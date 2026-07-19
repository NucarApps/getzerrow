import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createBot, leaveBot, detectPlatform, type TranscriptSegment } from "../recall.server";
import { logError } from "../log.server";
import {
  extractMeetingUrl,
  NO_LINK_MESSAGE,
  EMAIL_RE,
  DOMAIN_RE,
  DEFAULT_CHAT_MESSAGE,
  SPECIAL_EVENT_TYPES,
  DEFAULT_HIDDEN_TYPES,
  EVENT_COLOR_IDS,
} from "../meetings-helpers.server";

export const listMeetings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("meetings")
      .select(
        "id, title, meeting_url, platform, status, source, scheduled_start, started_at, ended_at, recording_url, summary, recall_bot_id, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    const { computeCanResendBot } = await import("../meetings-autojoin.server");
    const meetings = (data ?? []).map((m) => ({
      ...m,
      canResendBot: computeCanResendBot({
        recallBotId: m.recall_bot_id,
        meetingUrl: m.meeting_url,
        status: m.status,
        recordingUrl: m.recording_url,
        scheduledStart: m.scheduled_start,
      }),
    }));
    return { meetings };
  });

/** List meetings a given contact participated in. */
export const listMeetingsForContact = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ contactId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: parts, error } = await context.supabase
      .from("meeting_participants")
      .select("meeting_id, meetings!inner(id, title, status, scheduled_start, created_at, summary)")
      .eq("contact_id", data.contactId);
    if (error) throw new Error(error.message);
    type Row = {
      meetings: {
        id: string;
        title: string | null;
        status: string;
        scheduled_start: string | null;
        created_at: string;
        summary: string | null;
      };
    };
    const meetings = (parts as unknown as Row[] | null)?.map((p) => p.meetings) ?? [];
    meetings.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { meetings };
  });

/** Fetch one meeting with its participants. */
export const getMeeting = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: meeting, error } = await context.supabase
      .from("meetings")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!meeting) throw new Error("Meeting not found");
    const { data: participants } = await context.supabase
      .from("meeting_participants")
      .select("id, email, name, contact_id")
      .eq("meeting_id", data.id);
    return { meeting, participants: participants ?? [] };
  });

export const deleteMeeting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: meeting } = await context.supabase
      .from("meetings")
      .select("id, recall_bot_id, status")
      .eq("id", data.id)
      .maybeSingle();
    if (!meeting) throw new Error("Meeting not found");
    if (meeting.recall_bot_id && meeting.status !== "done" && meeting.status !== "failed") {
      try {
        await leaveBot(meeting.recall_bot_id);
      } catch (e) {
        logError("meeting_leave_bot_failed", { meetingId: data.id }, e);
      }
    }
    const { error } = await context.supabase.from("meetings").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Rename a meeting. An empty title clears it (falls back to "Untitled meeting"). */
export const renameMeeting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ id: z.string().uuid(), title: z.string().max(200) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const title = data.title.trim() || null;
    const { error } = await context.supabase.from("meetings").update({ title }).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { title };
  });

/** Generate a meeting title on demand from its summary/transcript. */
export const generateTitleForMeeting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: meeting, error } = await context.supabase
      .from("meetings")
      .select("id, summary, transcript")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!meeting) throw new Error("Meeting not found");

    const transcriptText = Array.isArray(meeting.transcript)
      ? (meeting.transcript as { text?: string }[])
          .map((s) => s?.text ?? "")
          .join(" ")
          .trim()
      : "";
    const source = (meeting.summary?.trim() || transcriptText).trim();
    if (!source) {
      throw new Error("Add a recording first — there's nothing to base a title on yet.");
    }

    const { generateMeetingTitle } = await import("../meetings.server");
    const title = await generateMeetingTitle(source);
    if (!title) throw new Error("Couldn't generate a title. Please try again.");

    const { error: updateError } = await context.supabase
      .from("meetings")
      .update({ title })
      .eq("id", data.id);
    if (updateError) throw new Error(updateError.message);
    return { title };
  });

/**
 * Regenerate a meeting's AI breakdown from its stored transcript, on demand.
 * Falls back to the compact extractive digest if the AI call fails.
 */
export const regenerateMeetingSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: meeting, error } = await context.supabase
      .from("meetings")
      .select("id, transcript")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!meeting) throw new Error("Meeting not found");

    const segments = Array.isArray(meeting.transcript)
      ? (meeting.transcript as unknown as TranscriptSegment[])
      : [];
    if (!segments.length) {
      throw new Error("No transcript yet — record the meeting first.");
    }

    const { generateMeetingBreakdown, transcriptSegmentsToText } =
      await import("../meetings.server");
    const { summarizeTranscript } = await import("../recall.server");
    const breakdown = await generateMeetingBreakdown(transcriptSegmentsToText(segments));
    const summary = breakdown ?? summarizeTranscript(segments);
    if (!summary) throw new Error("Couldn't generate a summary. Please try again.");

    const { error: updateError } = await context.supabase
      .from("meetings")
      .update({ summary })
      .eq("id", data.id);
    if (updateError) throw new Error(updateError.message);
    return { summary };
  });
