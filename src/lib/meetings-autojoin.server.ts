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
  blocked: boolean;
  blockedBy: string | null;
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

/** The caller's don't-auto-record list, split into exact emails and domains. */
type Blocklist = { emails: Set<string>; domains: Set<string> };

async function loadBlocklist(userId: string): Promise<Blocklist> {
  const { data } = await supabaseAdmin
    .from("meeting_record_blocklist")
    .select("value")
    .eq("user_id", userId);
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const row of data ?? []) {
    const value = (row.value ?? "").toLowerCase();
    if (value.includes("@")) emails.add(value);
    else if (value) domains.add(value);
  }
  return { emails, domains };
}

/** True when any attendee/organizer email is on the user's don't-record list. */
function hasBlockedAttendee(emails: string[], blocklist: Blocklist): boolean {
  return findBlockedEntry(emails, blocklist) !== null;
}

/** Return the first email/domain that matches the don't-record list, or null. */
function findBlockedEntry(emails: string[], blocklist: Blocklist): string | null {
  for (const raw of emails) {
    const email = (raw ?? "").toLowerCase();
    if (!email) continue;
    if (blocklist.emails.has(email)) return email;
    const domain = email.slice(email.indexOf("@") + 1);
    if (domain && blocklist.domains.has(domain)) return domain;
  }
  return null;
}

/** Normalize a meeting URL for comparison: lowercase host, drop query/hash. */
function normalizeMeetingUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * For a pasted meeting link, look across the user's calendar-enabled accounts
 * for a matching event and return a blocked attendee/domain if one is invited.
 * Returns null when the list is empty, no matching event is found, or nobody is
 * blocked. Server-only; used to refuse manual "record from link".
 */
export async function findBlockedAttendeeForMeetingUrl(
  userId: string,
  meetingUrl: string,
): Promise<string | null> {
  const blocklist = await loadBlocklist(userId);
  if (blocklist.emails.size === 0 && blocklist.domains.size === 0) return null;

  const target = normalizeMeetingUrl(meetingUrl);

  const { data: accounts } = await supabaseAdmin
    .from("gmail_accounts")
    .select("id")
    .eq("user_id", userId)
    .eq("calendar_access", true);

  for (const account of accounts ?? []) {
    let events: UpcomingEvent[];
    try {
      events = await fetchEventsInWindow(account.id, LIST_LOOKAHEAD_MINUTES);
    } catch (e) {
      logError("meeting_blocklist_calendar_failed", { userId, accountId: account.id }, e);
      continue;
    }
    for (const event of events) {
      const url = extractMeetingUrl(event);
      if (!url || normalizeMeetingUrl(url) !== target) continue;
      const emails = [
        ...(event.attendees ?? []).map((a) => a.email),
        event.organizer?.email,
      ].filter((e): e is string => !!e);
      const blocked = findBlockedEntry(emails, blocklist);
      if (blocked) return blocked;
    }
  }
  return null;
}

/** Load a user's blocklist and check a set of participant emails. Server-only. */
export async function findBlockedEmailForUser(
  userId: string,
  emails: string[],
): Promise<string | null> {
  if (emails.length === 0) return null;
  const blocklist = await loadBlocklist(userId);
  if (blocklist.emails.size === 0 && blocklist.domains.size === 0) return null;
  return findBlockedEntry(emails, blocklist);
}

/** Schedule bots for every account that has auto-record enabled. */
export async function scheduleUpcomingMeetingBots(runId: string): Promise<{ scheduled: number }> {
  const { data: accounts } = await supabaseAdmin
    .from("gmail_accounts")
    .select("id, user_id, email_address, auto_record_meetings, calendar_access")
    .eq("auto_record_meetings", true)
    .eq("calendar_access", true);

  // Cache each user's blocklist once per run (a user can have multiple accounts).
  const blocklistCache = new Map<string, Blocklist>();

  let scheduled = 0;
  for (const account of accounts ?? []) {

    let events: UpcomingEvent[];
    try {
      events = await fetchUpcomingEvents(account.id);
    } catch (e) {
      logError("meeting_autojoin_calendar_failed", { runId, accountId: account.id }, e);
      continue;
    }

    // Load the user's bot customization once per account (applies to every
    // event we schedule below).
    const botCfg = await loadBotConfig(account.user_id);

    // Load the user's don't-auto-record list (cached per user for the run).
    let blocklist = blocklistCache.get(account.user_id);
    if (!blocklist) {
      blocklist = await loadBlocklist(account.user_id);
      blocklistCache.set(account.user_id, blocklist);
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

      // Skip auto-recording if anyone on the user's don't-record list is here.
      if (hasBlockedAttendee(participants.map((p) => p.email), blocklist)) {
        logInfo("meeting_autojoin_skipped_blocklist", {
          runId,
          accountId: account.id,
          eventId: event.id,
        });
        continue;
      }



      try {
        const bot = await createBot({
          meetingUrl,
          botName: botCfg.botName,
          joinAt: start,
          chatMessage: botCfg.chatMessage,
          chatResendOnJoin: botCfg.chatResendOnJoin,
          imageB64: botCfg.imageB64,
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
