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

export const recordFromLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => {
    const raw = z
      .object({
        meetingUrl: z.string(),
        title: z.string().max(200).optional(),
        accountId: z.string().uuid().optional(),
      })
      .parse(input);
    const meetingUrl = extractMeetingUrl(raw.meetingUrl);
    if (!meetingUrl) throw new Error(NO_LINK_MESSAGE);
    return { ...raw, meetingUrl };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // If an account was passed, confirm ownership.
    if (data.accountId) {
      const { data: acct } = await supabase
        .from("gmail_accounts")
        .select("id")
        .eq("id", data.accountId)
        .maybeSingle();
      if (!acct) throw new Error("Account not found");
    }

    // Refuse to record when the meeting (matched on the calendar) includes
    // someone on the user's don't-record list.
    const { findBlockedAttendeeForMeetingUrl } = await import("../meetings-autojoin.server");
    const blocked = await findBlockedAttendeeForMeetingUrl(userId, data.meetingUrl);
    if (blocked) {
      throw new Error(`Not recorded — ${blocked} is on your don't-record list.`);
    }

    let botId: string;
    try {
      const { loadBotConfig } = await import("../meetings.server");
      const cfg = await loadBotConfig(userId);
      const bot = await createBot({
        meetingUrl: data.meetingUrl,
        botName: cfg.botName,
        chatMessage: cfg.chatMessage,
        chatResendOnJoin: cfg.chatResendOnJoin,
        imageB64: cfg.imageB64,
        everyoneLeftTimeoutSec: cfg.autoLeaveEnabled ? cfg.autoLeaveMinutes * 60 : null,
        inCallNotRecordingTimeoutSec: cfg.autoLeaveEnabled ? cfg.autoLeaveMinutes * 60 : null,
      });
      botId = bot.id;
    } catch (e) {
      logError("meeting_record_from_link_failed", { userId }, e);
      throw new Error("Could not start the recording bot. Check the link and try again.", {
        cause: e,
      });
    }

    const { data: inserted, error } = await supabase
      .from("meetings")
      .insert({
        user_id: userId,
        gmail_account_id: data.accountId ?? null,
        recall_bot_id: botId,
        title: data.title ?? null,
        meeting_url: data.meetingUrl,
        platform: detectPlatform(data.meetingUrl),
        status: "joining",
        source: "link",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: inserted.id };
  });

/** List the caller's meetings, newest first. */
export const listMeetings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("meetings")
      .select(
        "id, title, meeting_url, platform, status, source, scheduled_start, started_at, ended_at, recording_url, summary, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return { meetings: data ?? [] };
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

/**
 * Pull the live bot state from Recall for one of the caller's meetings and
 * persist the resolved status (and recording/transcript/summary when ready).
 * Works on demand from the UI without waiting for the webhook or reconcile cron.
 */
export const syncMeeting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    // Ownership is enforced by RLS on the per-user client.
    const { data: meeting } = await context.supabase
      .from("meetings")
      .select("id, user_id, recall_bot_id, status, title")
      .eq("id", data.id)
      .maybeSingle();
    if (!meeting) throw new Error("Meeting not found");
    if (!meeting.recall_bot_id || meeting.status === "done" || meeting.status === "failed") {
      return { status: meeting.status };
    }
    // Dynamic import keeps the service-role module out of the client bundle.
    const { syncMeetingFromRecall } = await import("../meetings.server");
    const status = await syncMeetingFromRecall(meeting);
    return { status };
  });

/**
 * Force a stuck recording to end: remove the notetaker bot from the call and
 * immediately pull the finalized state from Recall. Used when a meeting is
 * stuck in a non-terminal status because Recall never sent a "call ended"
 * signal. No-op for meetings that are already terminal or have no bot.
 */
export const stopMeeting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    // Ownership is enforced by RLS on the per-user client.
    const { data: meeting } = await context.supabase
      .from("meetings")
      .select("id, user_id, recall_bot_id, status, title")
      .eq("id", data.id)
      .maybeSingle();
    if (!meeting) throw new Error("Meeting not found");
    if (meeting.status === "done" || meeting.status === "failed") {
      return { status: meeting.status };
    }
    if (!meeting.recall_bot_id) {
      throw new Error("This recording can't be stopped remotely.");
    }

    // Best-effort: force the bot out of the call. leaveBot swallows 400/404
    // ("already gone"), so a bot that already left won't block finalizing.
    try {
      await leaveBot(meeting.recall_bot_id);
    } catch (e) {
      logError("meeting_stop_leave_failed", { userId: context.userId, id: data.id }, e);
    }

    // Dynamic import keeps the service-role module out of the client bundle.
    const { syncMeetingFromRecall } = await import("../meetings.server");
    const status = await syncMeetingFromRecall(meeting);
    return { status };
  });



/**
 * For a finished meeting, fetch a fresh signed recording URL from Recall (the
 * stored one expires) and backfill the transcript/summary if they never
 * arrived. Returns the fresh recording URL to play.
 */
export const refreshRecording = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    // Ownership is enforced by RLS on the per-user client.
    const { data: meeting } = await context.supabase
      .from("meetings")
      .select(
        "id, recall_bot_id, audio_storage_path, video_storage_path, transcript, summary, status",
      )
      .eq("id", data.id)
      .maybeSingle();
    if (!meeting) throw new Error("Meeting not found");
    // In-person recordings live in our own storage bucket, not Recall. Report
    // what's on the row so the detail view can show status without calling out.
    if (meeting.audio_storage_path || meeting.video_storage_path) {
      return {
        recordingUrl: null as string | null,
        hasRecording: true,
        hasTranscript: !!meeting.transcript,
        hasSummary: !!meeting.summary,
      };
    }
    if (!meeting.recall_bot_id) {
      return { recordingUrl: null, hasRecording: false, hasTranscript: false, hasSummary: false };
    }
    // Dynamic import keeps the service-role module out of the client bundle.
    const { refreshMeetingRecording } = await import("../meetings.server");
    return refreshMeetingRecording(meeting.id);
  });

/**
 * Mint a short-lived, same-origin streaming URL for a finished meeting's
 * recording. The <video> element can't carry an auth header, so we sign a
 * token (verified by the public streaming route) instead of exposing the raw,
 * short-lived S3 URL. Ownership is enforced by RLS on the per-user client.
 */
export const getRecordingStreamUrl = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: meeting } = await context.supabase
      .from("meetings")
      .select("id, recall_bot_id, recording_url, audio_storage_path, video_storage_path")
      .eq("id", data.id)
      .maybeSingle();
    if (!meeting) throw new Error("Meeting not found");
    const { buildRecordingStreamPath } = await import("../meeting-stream.server");
    // Stored in-person recordings go through the same playback proxy as bot
    // recordings so the response carries browser-friendly media headers.
    if (meeting.video_storage_path || meeting.audio_storage_path) {
      return {
        streamUrl: buildRecordingStreamPath(meeting.id),
        kind: meeting.video_storage_path ? ("video" as const) : ("audio" as const),
      };
    }
    if (!meeting.recall_bot_id && !meeting.recording_url) {
      return { streamUrl: null as string | null, kind: "video" as const };
    }
    return { streamUrl: buildRecordingStreamPath(meeting.id), kind: "video" as const };
  });

/**
 * Create a meeting row for an in-person recording. Returns the new id and the
 * storage path the client should upload the audio blob to, so the upload lands
 * under the caller's own {userId}/ prefix (enforced by storage RLS).
 */
export const createInPersonMeeting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        title: z.string().max(200).optional(),
        ext: z.enum(["webm", "m4a", "mp4", "ogg", "wav"]).default("webm"),
        withVideo: z.boolean().optional(),
        videoExt: z.enum(["webm", "mp4"]).default("webm"),
        // Optional link back to the calendar meeting this recording captures,
        // so the note lands under the meeting and the bot stays away from it.
        calendarEventId: z.string().min(1).max(1024).optional(),
        accountId: z.string().uuid().optional(),
        scheduledStart: z
          .string()
          .max(64)
          .refine((v) => !Number.isNaN(Date.parse(v)), { message: "Invalid start time" })
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // If the recording is tied to a calendar event, confirm account ownership.
    if (data.accountId) {
      const { data: acct } = await supabase
        .from("gmail_accounts")
        .select("id")
        .eq("id", data.accountId)
        .maybeSingle();
      if (!acct) throw new Error("Account not found");
    }
    const { data: inserted, error } = await supabase
      .from("meetings")
      .insert({
        user_id: userId,
        meeting_url: null,
        platform: "in_person",
        source: "in_person",
        status: "processing",
        title: data.title?.trim() || "In-person meeting",
        started_at: new Date().toISOString(),
        gmail_account_id: data.accountId ?? null,
        calendar_event_id: data.calendarEventId ?? null,
        scheduled_start: data.scheduledStart ? new Date(data.scheduledStart).toISOString() : null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const audioPath = `${userId}/${inserted.id}.${data.ext}`;
    const videoPath = data.withVideo ? `${userId}/${inserted.id}.video.${data.videoExt}` : null;
    return { id: inserted.id, audioPath, videoPath };
  });

/**
 * After the client has uploaded the audio, record its storage path, then
 * transcribe and summarize it. Ownership is enforced by RLS on the per-user
 * client; the heavy lifting runs in a server-only helper.
 */
export const transcribeInPersonMeeting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        audioPath: z.string().max(300),
        videoPath: z.string().max(300).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Confirm ownership and that the path is under the caller's prefix.
    const { data: meeting } = await supabase
      .from("meetings")
      .select("id, source")
      .eq("id", data.id)
      .maybeSingle();
    if (!meeting) throw new Error("Meeting not found");
    if (!data.audioPath.startsWith(`${userId}/`)) throw new Error("Invalid audio path");
    if (data.videoPath && !data.videoPath.startsWith(`${userId}/`)) {
      throw new Error("Invalid video path");
    }

    const { error: updErr } = await supabase
      .from("meetings")
      .update({
        audio_storage_path: data.audioPath,
        ...(data.videoPath ? { video_storage_path: data.videoPath } : {}),
        status: "processing",
      })
      .eq("id", data.id);
    if (updErr) throw new Error(updErr.message);

    // Dynamic import keeps the service-role module out of the client bundle.
    const { finalizeInPersonMeeting } = await import("../meetings.server");
    const status = await finalizeInPersonMeeting(data.id);
    return { status };
  });
