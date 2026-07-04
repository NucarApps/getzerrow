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

    let botId: string;
    try {
      const bot = await createBot({ meetingUrl: data.meetingUrl, botName: "Zerrow Notetaker" });
      botId = bot.id;
    } catch (e) {
      logError("meeting_record_from_link_failed", { userId }, e);
      throw new Error("Could not start the recording bot. Check the link and try again.");
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
      .select(
        "meeting_id, meetings!inner(id, title, status, scheduled_start, created_at, summary)",
      )
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
      .select("id, user_id, recall_bot_id, status")
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
      .select("id, recall_bot_id, status")
      .eq("id", data.id)
      .maybeSingle();
    if (!meeting) throw new Error("Meeting not found");
    if (!meeting.recall_bot_id) return { recordingUrl: null };
    // Dynamic import keeps the service-role module out of the client bundle.
    const { refreshMeetingRecording } = await import("./meetings.server");
    return refreshMeetingRecording(meeting.id);
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

/** Auto-record status for one account (used by the settings card). */
export const getAutoRecordStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ accountId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: acct, error } = await context.supabase
      .from("gmail_accounts")
      .select("auto_record_meetings, calendar_access")
      .eq("id", data.accountId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      enabled: !!acct?.auto_record_meetings,
      calendarAccess: !!acct?.calendar_access,
    };
  });
