// Server functions for the Meetings feature. Auth-scoped via requireSupabaseAuth;
// all reads/writes go through the per-user RLS client on context.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createBot, leaveBot, detectPlatform } from "./recall.server";
import { logError } from "./log.server";

const MEETING_URL_RE =
  /^https?:\/\/(?:[a-z0-9-]+\.)*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com)\//i;

// Same pattern, but matches anywhere within a longer string (invite emails,
// calendar blurbs) so we can pull the join link out of pasted text.
const MEETING_URL_SCAN_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com)\/[^\s<>"')]*/i;

/**
 * Pull the first supported meeting URL out of any pasted text. Returns the
 * clean link, or null when no supported link is present.
 */
export function extractMeetingUrl(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (MEETING_URL_RE.test(trimmed)) return trimmed;
  const match = trimmed.match(MEETING_URL_SCAN_RE);
  return match ? match[0] : null;
}

const NO_LINK_MESSAGE =
  "We couldn't find a supported meeting link. Paste a Zoom, Google Meet, or Microsoft Teams link.";

/** Send a bot to a pasted meeting link and record the meeting. */
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
    const { findBlockedAttendeeForMeetingUrl } = await import("./meetings-autojoin.server");
    const blocked = await findBlockedAttendeeForMeetingUrl(userId, data.meetingUrl);
    if (blocked) {
      throw new Error(`Not recorded — ${blocked} is on your don't-record list.`);
    }

    let botId: string;
    try {
      const { loadBotConfig } = await import("./meetings.server");
      const cfg = await loadBotConfig(userId);
      const bot = await createBot({
        meetingUrl: data.meetingUrl,
        botName: cfg.botName,
        chatMessage: cfg.chatMessage,
        chatResendOnJoin: cfg.chatResendOnJoin,
        imageB64: cfg.imageB64,
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
    const { syncMeetingFromRecall } = await import("./meetings.server");
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
    const { refreshMeetingRecording } = await import("./meetings.server");
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
    const { buildRecordingStreamPath } = await import("./meeting-stream.server");
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
    const { finalizeInPersonMeeting } = await import("./meetings.server");
    const status = await finalizeInPersonMeeting(data.id);
    return { status };
  });

/** Delete a meeting and best-effort remove the bot from the call. */
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

    const { generateMeetingTitle } = await import("./meetings.server");
    const title = await generateMeetingTitle(source);
    if (!title) throw new Error("Couldn't generate a title. Please try again.");

    const { error: updateError } = await context.supabase
      .from("meetings")
      .update({ title })
      .eq("id", data.id);
    if (updateError) throw new Error(updateError.message);
    return { title };
  });

/** Toggle calendar auto-record for one connected account. */
export const setAutoRecord = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ accountId: z.string().uuid(), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("gmail_accounts")
      .update({ auto_record_meetings: data.enabled })
      .eq("id", data.accountId);
    if (error) throw new Error(error.message);
    return { enabled: data.enabled };
  });

/** Toggle "record meetings I've declined" for one connected account. */
export const setRecordDeclined = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ accountId: z.string().uuid(), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("gmail_accounts")
      .update({ record_declined_meetings: data.enabled })
      .eq("id", data.accountId);
    if (error) throw new Error(error.message);
    return { enabled: data.enabled };
  });

/** Auto-record status for one account (used by the settings card). */
export const getAutoRecordStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ accountId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: acct, error } = await context.supabase
      .from("gmail_accounts")
      .select("auto_record_meetings, calendar_access, record_declined_meetings")
      .eq("id", data.accountId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      enabled: !!acct?.auto_record_meetings,
      calendarAccess: !!acct?.calendar_access,
      recordDeclined: !!acct?.record_declined_meetings,
    };
  });

type UpcomingCalendarEvent = import("./meetings-autojoin.server").UpcomingCalendarEvent;

/**
 * List upcoming calendar events (next 14 days) for one account so the user can
 * choose which ones the notetaker should skip. RLS confirms account ownership.
 */
export const listUpcomingCalendarEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ accountId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: acct } = await context.supabase
      .from("gmail_accounts")
      .select("calendar_access, record_declined_meetings")
      .eq("id", data.accountId)
      .maybeSingle();
    if (!acct) throw new Error("Account not found");
    const recordDeclined = !!acct.record_declined_meetings;
    if (!acct.calendar_access) {
      return { calendarAccess: false, events: [] as UpcomingCalendarEvent[], recordDeclined };
    }
    const { listUpcomingCalendarEventsForAccount } = await import("./meetings-autojoin.server");
    try {
      const events = await listUpcomingCalendarEventsForAccount(data.accountId, context.userId);
      return { calendarAccess: true, events, recordDeclined };
    } catch (e) {
      logError(
        "meeting_list_events_failed",
        { accountId: data.accountId, userId: context.userId },
        e,
      );
      return {
        calendarAccess: true,
        events: [] as UpcomingCalendarEvent[],
        recordDeclined,
        error: "Couldn't load your calendar events right now.",
      };
    }
  });

/** An upcoming calendar event annotated with the inbox it came from. */
export type UpcomingCalendarEventWithAccount = UpcomingCalendarEvent & {
  accountId: string;
  accountEmail: string | null;
};

/**
 * List upcoming calendar events (next 14 days) across all of the caller's
 * calendar-enabled inboxes, merged into one time-sorted list so the meetings
 * page can show what the notetaker will join. Per-account Google failures are
 * logged and skipped so one bad inbox doesn't break the whole list.
 */
export const listAllUpcomingCalendarEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: accounts } = await context.supabase
      .from("gmail_accounts")
      .select("id, email_address, calendar_access")
      .eq("calendar_access", true);

    if (!accounts || accounts.length === 0) {
      return { calendarAccess: false, events: [] as UpcomingCalendarEventWithAccount[] };
    }

    const { listUpcomingCalendarEventsForAccount } = await import("./meetings-autojoin.server");
    const events: UpcomingCalendarEventWithAccount[] = [];
    for (const acct of accounts) {
      try {
        const accountEvents = await listUpcomingCalendarEventsForAccount(acct.id, context.userId);
        for (const e of accountEvents) {
          events.push({ ...e, accountId: acct.id, accountEmail: acct.email_address ?? null });
        }
      } catch (e) {
        logError(
          "meeting_list_all_events_failed",
          { accountId: acct.id, userId: context.userId },
          e,
        );
      }
    }

    events.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
    return { calendarAccess: true, events };
  });

/** Exclude (or re-include) one calendar event from auto-record. */
export const setEventExclusion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        accountId: z.string().uuid(),
        calendarEventId: z.string().min(1).max(1024),
        excluded: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: acct } = await context.supabase
      .from("gmail_accounts")
      .select("id")
      .eq("id", data.accountId)
      .maybeSingle();
    if (!acct) throw new Error("Account not found");
    if (data.excluded) {
      const { upsertEventExclusion } = await import("./meetings-autojoin.server");
      const errorMessage = await upsertEventExclusion(
        context.supabase,
        {
          userId: context.userId,
          accountId: data.accountId,
          calendarEventId: data.calendarEventId,
        },
        "off",
      );
      if (errorMessage) throw new Error(errorMessage);
    } else {
      const { error } = await context.supabase
        .from("meeting_autojoin_exclusions")
        .delete()
        .eq("user_id", context.userId)
        .eq("calendar_event_id", data.calendarEventId);
      if (error) throw new Error(error.message);
    }
    return { excluded: data.excluded };
  });

/**
 * Set how one calendar meeting should be captured: send the notetaker bot
 * (default — no exclusion row), record in person yourself, or don't record.
 * "in_person" and "off" both keep the bot out; the mode remembers why so the
 * web and iOS apps can show the same three-way choice.
 */
export const setEventRecordingMode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        accountId: z.string().uuid(),
        calendarEventId: z.string().min(1).max(1024),
        mode: z.enum(["bot", "in_person", "off"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: acct } = await context.supabase
      .from("gmail_accounts")
      .select("id")
      .eq("id", data.accountId)
      .maybeSingle();
    if (!acct) throw new Error("Account not found");
    if (data.mode === "bot") {
      const { error } = await context.supabase
        .from("meeting_autojoin_exclusions")
        .delete()
        .eq("user_id", context.userId)
        .eq("calendar_event_id", data.calendarEventId);
      if (error) throw new Error(error.message);
    } else {
      const { upsertEventExclusion } = await import("./meetings-autojoin.server");
      const errorMessage = await upsertEventExclusion(
        context.supabase,
        {
          userId: context.userId,
          accountId: data.accountId,
          calendarEventId: data.calendarEventId,
        },
        data.mode,
      );
      if (errorMessage) throw new Error(errorMessage);
    }
    return { mode: data.mode };
  });

// A blocklist entry is either a full email (jane@lawfirm.com) or a bare
// domain (lawfirm.com) to skip everyone at a firm.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;

/** People/domains the caller never wants auto-recorded. */
export const listRecordBlocklist = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("meeting_record_blocklist")
      .select("id, value, created_at")
      .eq("user_id", context.userId)
      .order("value", { ascending: true });
    if (error) throw new Error(error.message);
    return { entries: data ?? [] };
  });

/** Add an email or domain to the caller's don't-auto-record list. */
export const addRecordBlocklistEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        value: z
          .string()
          .trim()
          .min(1)
          .max(320)
          .transform((v) => v.toLowerCase())
          .refine((v) => EMAIL_RE.test(v) || DOMAIN_RE.test(v), {
            message: "Enter a valid email address or domain.",
          }),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("meeting_record_blocklist")
      .upsert({ user_id: context.userId, value: data.value }, { onConflict: "user_id,value" });
    if (error) throw new Error(error.message);
    return { ok: true, value: data.value };
  });

/** Remove an entry from the caller's don't-auto-record list. */
export const removeRecordBlocklistEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("meeting_record_blocklist")
      .delete()
      .eq("user_id", context.userId)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const DEFAULT_CHAT_MESSAGE =
  "Hi! I'm the Zerrow notetaker. I'm here to record and summarize this meeting.";

/** Get the caller's meeting-bot customization (name, chat message, picture). */
export const getMeetingBotSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("meeting_bot_settings")
      .select("bot_name, chat_message, chat_resend_on_join, avatar_updated_at")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      botName: data?.bot_name ?? "Zerrow Notetaker",
      chatMessage: data?.chat_message ?? DEFAULT_CHAT_MESSAGE,
      chatResendOnJoin: data?.chat_resend_on_join ?? true,
      hasAvatar: !!data?.avatar_updated_at,
    };
  });

/**
 * Save the caller's meeting-bot customization. The picture itself is uploaded
 * straight to storage by the client (RLS-scoped to the user's own folder);
 * this only records the text/toggle settings and whether an avatar now exists.
 */
export const updateMeetingBotSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        botName: z.string().trim().min(1).max(100),
        chatMessage: z.string().max(1000),
        chatResendOnJoin: z.boolean(),
        // "set" when a new picture was just uploaded, "clear" to remove it,
        // omitted to leave the existing picture untouched.
        avatar: z.enum(["set", "clear"]).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: {
      user_id: string;
      bot_name: string;
      chat_message: string;
      chat_resend_on_join: boolean;
      avatar_updated_at?: string | null;
    } = {
      user_id: context.userId,
      bot_name: data.botName.trim(),
      chat_message: data.chatMessage.trim(),
      chat_resend_on_join: data.chatResendOnJoin,
    };
    if (data.avatar === "set") patch.avatar_updated_at = new Date().toISOString();
    if (data.avatar === "clear") {
      patch.avatar_updated_at = null;
      await context.supabase.storage
        .from("meeting-bot-avatars")
        .remove([`${context.userId}/avatar.jpg`]);
    }

    const { error } = await context.supabase
      .from("meeting_bot_settings")
      .upsert(patch, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
