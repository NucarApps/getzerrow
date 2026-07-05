// Calendar auto-join: scan upcoming primary-calendar events for accounts that
// enabled auto-record, extract the meeting URL, and schedule a Recall bot to
// join at start time. Deduped on (user_id, calendar_event_id). Server-only.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getAccessToken } from "./google-oauth.server";
import { createBot, detectPlatform } from "./recall.server";
import { loadBotConfig } from "./meetings.server";
import { logError, logInfo } from "./log.server";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const REQUEST_TIMEOUT_MS = 20_000;
// How far ahead to look, and the lead time before start when we send the bot.
const LOOKAHEAD_MINUTES = 20;

type ConferenceEntryPoint = { entryPointType?: string; uri?: string };
type UpcomingEvent = {
  id?: string;
  summary?: string;
  hangoutLink?: string;
  location?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  conferenceData?: { entryPoints?: ConferenceEntryPoint[] };
  attendees?: Array<{ email?: string; displayName?: string; self?: boolean }>;
  organizer?: { email?: string; displayName?: string; self?: boolean };
};

const MEETING_URL_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com)\/[^\s"'<>)]+/i;

/** Pull the first supported meeting URL from an event's various fields. */
export function extractMeetingUrl(event: UpcomingEvent): string | null {
  const video = event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;
  if (video && MEETING_URL_RE.test(video)) return video;
  if (event.hangoutLink && MEETING_URL_RE.test(event.hangoutLink)) return event.hangoutLink;
  for (const field of [event.location, event.description]) {
    const match = field?.match(MEETING_URL_RE);
    if (match) return match[0];
  }
  return null;
}

async function fetchEventsInWindow(
  accountId: string,
  minutesAhead: number,
): Promise<UpcomingEvent[]> {
  const token = await getAccessToken(accountId);
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + minutesAhead * 60_000).toISOString();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "100",
    showDeleted: "false",
    conferenceDataVersion: "1",
  });
  const res = await fetch(`${CALENDAR_BASE}/calendars/primary/events?${params.toString()}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Calendar events ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { items?: UpcomingEvent[] };
  return body.items ?? [];
}

async function fetchUpcomingEvents(accountId: string): Promise<UpcomingEvent[]> {
  return fetchEventsInWindow(accountId, LOOKAHEAD_MINUTES);
}

/** One upcoming calendar event surfaced in the settings notetaker list. */
export type UpcomingCalendarEvent = {
  id: string;
  title: string | null;
  start: string | null;
  hasMeetingLink: boolean;
  scheduled: boolean;
  excluded: boolean;
};

const LIST_LOOKAHEAD_MINUTES = 14 * 24 * 60; // 14 days

/**
 * List the account's upcoming events (next 14 days) for the settings UI, with
 * flags for whether each has a supported meeting link, already has a bot
 * scheduled, and is currently excluded from auto-record.
 */
export async function listUpcomingCalendarEventsForAccount(
  accountId: string,
  userId: string,
): Promise<UpcomingCalendarEvent[]> {
  const events = await fetchEventsInWindow(accountId, LIST_LOOKAHEAD_MINUTES);

  const eventIds = events.map((e) => e.id).filter((id): id is string => !!id);
  if (eventIds.length === 0) return [];

  const [{ data: scheduledRows }, { data: excludedRows }] = await Promise.all([
    supabaseAdmin
      .from("meetings")
      .select("calendar_event_id")
      .eq("user_id", userId)
      .in("calendar_event_id", eventIds),
    supabaseAdmin
      .from("meeting_autojoin_exclusions")
      .select("calendar_event_id")
      .eq("user_id", userId)
      .in("calendar_event_id", eventIds),
  ]);

  const scheduledSet = new Set(
    (scheduledRows ?? []).map((r) => r.calendar_event_id).filter((id): id is string => !!id),
  );
  const excludedSet = new Set((excludedRows ?? []).map((r) => r.calendar_event_id));

  return events
    .filter((e) => !!e.id)
    .map((e) => ({
      id: e.id as string,
      title: e.summary ?? null,
      start: e.start?.dateTime ?? e.start?.date ?? null,
      hasMeetingLink: !!extractMeetingUrl(e),
      scheduled: scheduledSet.has(e.id as string),
      excluded: excludedSet.has(e.id as string),
    }));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Schedule bots for every account that has auto-record enabled. */
export async function scheduleUpcomingMeetingBots(runId: string): Promise<{ scheduled: number }> {
  const { data: accounts } = await supabaseAdmin
    .from("gmail_accounts")
    .select("id, user_id, email_address, auto_record_meetings, calendar_access")
    .eq("auto_record_meetings", true)
    .eq("calendar_access", true);

  let scheduled = 0;
  for (const account of accounts ?? []) {
    let events: UpcomingEvent[];
    try {
      events = await fetchUpcomingEvents(account.id);
    } catch (e) {
      logError("meeting_autojoin_calendar_failed", { runId, accountId: account.id }, e);
      continue;
    }

    for (const event of events) {
      if (!event.id) continue;
      const meetingUrl = extractMeetingUrl(event);
      if (!meetingUrl) continue;

      // Skip if we already scheduled/handled this calendar event.
      const { data: existing } = await supabaseAdmin
        .from("meetings")
        .select("id")
        .eq("user_id", account.user_id)
        .eq("calendar_event_id", event.id)
        .maybeSingle();
      if (existing) continue;

      // Skip events the user explicitly excluded from auto-record.
      const { data: excluded } = await supabaseAdmin
        .from("meeting_autojoin_exclusions")
        .select("id")
        .eq("user_id", account.user_id)
        .eq("calendar_event_id", event.id)
        .maybeSingle();
      if (excluded) continue;

      const start = event.start?.dateTime ?? event.start?.date ?? null;
      const self = (account.email_address ?? "").toLowerCase();
      const rawPeople: Array<{ email?: string; name?: string | null }> = [
        ...(event.attendees ?? []).map((a) => ({ email: a.email, name: a.displayName })),
      ];
      if (event.organizer?.email) {
        rawPeople.push({ email: event.organizer.email, name: event.organizer.displayName });
      }
      const participants = rawPeople
        .map((p) => ({ email: (p.email ?? "").toLowerCase(), name: p.name ?? null }))
        .filter((p) => p.email !== "" && p.email !== self && EMAIL_RE.test(p.email));

      try {
        const bot = await createBot({
          meetingUrl,
          botName: "Zerrow Notetaker",
          joinAt: start,
        });
        const { data: inserted, error } = await supabaseAdmin
          .from("meetings")
          .insert({
            user_id: account.user_id,
            gmail_account_id: account.id,
            recall_bot_id: bot.id,
            title: event.summary ?? null,
            meeting_url: meetingUrl,
            platform: detectPlatform(meetingUrl),
            status: "scheduled",
            source: "calendar",
            calendar_event_id: event.id,
            scheduled_start: start,
          })
          .select("id")
          .single();
        if (error) throw error;

        if (inserted && participants.length) {
          const dedup = [...new Map(participants.map((p) => [p.email, p])).values()];
          await supabaseAdmin.from("meeting_participants").insert(
            dedup.map((p) => ({ meeting_id: inserted.id, email: p.email, name: p.name })),
          );
        }
        scheduled++;
      } catch (e) {
        logError("meeting_autojoin_create_failed", { runId, accountId: account.id, eventId: event.id }, e);
      }
    }
  }

  logInfo("meeting_autojoin_done", { runId, scheduled });
  return { scheduled };
}
