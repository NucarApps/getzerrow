// Calendar auto-join: scan upcoming primary-calendar events for accounts that
// enabled auto-record, extract the meeting URL, and schedule a Recall bot to
// join at start time. Deduped on (user_id, calendar_event_id). Server-only.
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
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
  // Google's category for the entry. "default" is a normal meeting; other
  // values (outOfOffice, workingLocation, focusTime, birthday, fromGmail)
  // are not real meetings and can be hidden from the list.
  eventType?: string;
  // The event's color, if the user tagged one. 1-11 map to Google's palette;
  // undefined means the calendar's default color.
  colorId?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  conferenceData?: { entryPoints?: ConferenceEntryPoint[] };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    self?: boolean;
    responseStatus?: string;
  }>;
  organizer?: { email?: string; displayName?: string; self?: boolean };
};

/** Per-user preferences for which calendar entries the notetaker shows/records. */
export type EventFilterPrefs = {
  /** Google eventType values hidden from the list and never recorded. */
  hiddenEventTypes: Set<string>;
  /** Google colorId values the notetaker should not auto-join. */
  colorSkip: Set<string>;
};

const DEFAULT_HIDDEN_EVENT_TYPES = ["outOfOffice", "workingLocation", "focusTime", "birthday"];

/**
 * Load the user's event-type/color capture preferences. Never throws: on any
 * failure it falls back to hiding the standard non-meeting entry types and
 * skipping no colors, so listing and auto-join keep working.
 */
export async function loadEventFilterPrefs(userId: string): Promise<EventFilterPrefs> {
  try {
    const { data } = await supabaseAdmin
      .from("meeting_bot_settings")
      .select("hidden_event_types, event_color_skip")
      .eq("user_id", userId)
      .maybeSingle();
    return {
      hiddenEventTypes: new Set(data?.hidden_event_types ?? DEFAULT_HIDDEN_EVENT_TYPES),
      colorSkip: new Set(data?.event_color_skip ?? []),
    };
  } catch (e) {
    logError("meeting_event_filter_prefs_load_failed", { userId }, e);
    return { hiddenEventTypes: new Set(DEFAULT_HIDDEN_EVENT_TYPES), colorSkip: new Set() };
  }
}

/** True when an event is a non-meeting entry the user chose to hide. */
export function isHiddenEventType(event: UpcomingEvent, prefs: EventFilterPrefs): boolean {
  const t = event.eventType ?? "default";
  return t !== "default" && prefs.hiddenEventTypes.has(t);
}

/** True when the notetaker should skip an event because of its color tag. */
export function isColorSkipped(event: UpcomingEvent, prefs: EventFilterPrefs): boolean {
  return !!event.colorId && prefs.colorSkip.has(event.colorId);
}

/**
 * True when an event is all-day. Google returns `start.date` (no time) for
 * all-day entries and `start.dateTime` for timed meetings.
 */
export function isAllDayEvent(event: UpcomingEvent): boolean {
  return !event.start?.dateTime;
}

/**
 * True when the account owner has explicitly declined the event. Google returns
 * the owner's RSVP on the attendee entry marked `self`. Events where the owner
 * isn't listed as an attendee (e.g. they're only the organizer) count as not
 * declined, so behavior is unchanged for those.
 */
export function isDeclinedByUser(event: UpcomingEvent): boolean {
  const self = (event.attendees ?? []).find((a) => a.self);
  return self?.responseStatus === "declined";
}

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

/**
 * Resolve which Google calendars an account should record/list from. Reads the
 * user's stored per-calendar selection; when no rows exist yet the account
 * falls back to the primary calendar only (backwards compatible). When rows
 * exist but none are enabled, returns an empty list (record nothing).
 */
export async function resolveSelectedCalendarIds(accountId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("meeting_calendar_selections")
    .select("calendar_id, enabled")
    .eq("gmail_account_id", accountId);
  if (!data || data.length === 0) return ["primary"];
  return data.filter((r) => r.enabled).map((r) => r.calendar_id);
}

/** Fetch events from a single calendar within a time window. */
async function fetchCalendarEvents(
  token: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<UpcomingEvent[]> {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "100",
    showDeleted: "false",
    conferenceDataVersion: "1",
  });
  const res = await fetch(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    },
  );
  if (!res.ok)
    throw new Error(`Calendar events ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { items?: UpcomingEvent[] };
  return body.items ?? [];
}

/**
 * Fetch events across all of the account's selected calendars within a window,
 * merged and deduped by event id. Reads the per-calendar selection (primary
 * only when nothing is stored).
 */
async function fetchEventsInWindow(
  accountId: string,
  minutesAhead: number,
  minutesBack = 0,
): Promise<UpcomingEvent[]> {
  const calendarIds = await resolveSelectedCalendarIds(accountId);
  if (calendarIds.length === 0) return [];
  const token = await getAccessToken(accountId);
  const now = new Date();
  // minutesBack lets a caller widen the window into the past (e.g. the
  // "recently missed" list). Defaults to 0 so the bot scheduler keeps
  // starting exactly at `now`.
  const timeMin = new Date(now.getTime() - minutesBack * 60_000).toISOString();
  const timeMax = new Date(now.getTime() + minutesAhead * 60_000).toISOString();

  const byId = new Map<string, UpcomingEvent>();
  for (const calendarId of calendarIds) {
    let items: UpcomingEvent[];
    try {
      items = await fetchCalendarEvents(token, calendarId, timeMin, timeMax);
    } catch (e) {
      // A single bad calendar (e.g. removed) shouldn't drop the others.
      logError("meeting_calendar_fetch_failed", { accountId, calendarId }, e);
      continue;
    }
    for (const ev of items) {
      if (ev.id) byId.set(ev.id, ev);
    }
  }
  return [...byId.values()];
}

async function fetchUpcomingEvents(accountId: string): Promise<UpcomingEvent[]> {
  return fetchEventsInWindow(accountId, LOOKAHEAD_MINUTES);
}

/** One Google calendar as returned by the calendarList API. */
export type GoogleCalendarListEntry = {
  id: string;
  summary: string | null;
  primary: boolean;
};

/** List every calendar Google reports for an account (calendarList.list). */
export async function listGoogleCalendars(accountId: string): Promise<GoogleCalendarListEntry[]> {
  const token = await getAccessToken(accountId);
  const params = new URLSearchParams({ maxResults: "250", showHidden: "false" });
  const res = await fetch(`${CALENDAR_BASE}/users/me/calendarList?${params.toString()}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Calendar list ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    items?: Array<{ id?: string; summary?: string; summaryOverride?: string; primary?: boolean }>;
  };
  return (body.items ?? [])
    .filter((c): c is { id: string } & typeof c => !!c.id)
    .map((c) => ({
      id: c.id,
      summary: c.summaryOverride ?? c.summary ?? null,
      primary: !!c.primary,
    }));
}

/** How one upcoming meeting should be captured. */
export type MeetingRecordMode = "bot" | "in_person" | "off";

/** One upcoming calendar event surfaced in the settings notetaker list. */
export type UpcomingCalendarEvent = {
  id: string;
  title: string | null;
  start: string | null;
  hasMeetingLink: boolean;
  scheduled: boolean;
  excluded: boolean;
  recordMode: MeetingRecordMode;
  blocked: boolean;
  blockedBy: string | null;
  declined: boolean;
  /** Linked meeting row id, when a bot was already dispatched for this event. */
  meetingId: string | null;
  /** Current status of the linked meeting row, if any. */
  meetingStatus: string | null;
  /** True when the linked meeting already produced a recording. */
  hasRecording: boolean;
  /** True when the notetaker didn't join and the user can send a fresh bot. */
  canResendBot: boolean;
};

/** Grace period after start before an unfinished "scheduled/joining" meeting
 *  counts as a no-show and the resend button appears. */
const RESEND_START_GRACE_MS = 5 * 60_000;
/** How long after the scheduled start we still let the user resend a bot.
 *  Past this, the meeting is assumed over and the button disappears. */
const RESEND_MAX_LATE_MS = 2 * 60 * 60_000;

/**
 * True when the notetaker never captured the meeting and the user can
 * usefully send a fresh bot. Covers `failed`, and non-terminal states
 * (`scheduled` / `joining`) once the start time has slipped past the grace
 * period. Excludes meetings that already produced a recording or that are
 * more than two hours past their scheduled start.
 */
export function computeCanResendBot(input: {
  recallBotId: string | null;
  meetingUrl: string | null;
  status: string | null;
  recordingUrl: string | null;
  scheduledStart: string | null;
  now?: Date;
}): boolean {
  if (!input.recallBotId || !input.meetingUrl) return false;
  if (input.recordingUrl) return false;
  const status = input.status ?? "";
  if (!["scheduled", "joining", "failed"].includes(status)) return false;
  const now = input.now ?? new Date();
  const startMs = input.scheduledStart ? new Date(input.scheduledStart).getTime() : NaN;
  if (Number.isFinite(startMs)) {
    const delta = now.getTime() - startMs;
    // Too long after start: the meeting is over, resending is pointless.
    if (delta > RESEND_MAX_LATE_MS) return false;
    // Before/near start, only surface it for the explicit "failed" state —
    // a bot still in `scheduled`/`joining` may yet succeed.
    if (delta < RESEND_START_GRACE_MS && status !== "failed") return false;
  }
  return true;
}

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
  const prefs = await loadEventFilterPrefs(userId);
  const events = (await fetchEventsInWindow(accountId, LIST_LOOKAHEAD_MINUTES)).filter(
    (e) => !isHiddenEventType(e, prefs) && !isAllDayEvent(e) && !isColorSkipped(e, prefs),
  );

  const eventIds = events.map((e) => e.id).filter((id): id is string => !!id);
  if (eventIds.length === 0) return [];

  const [{ data: meetingRows }, { data: excludedRows }] = await Promise.all([
    supabaseAdmin
      .from("meetings")
      .select("id, calendar_event_id, status, recording_url, recall_bot_id, meeting_url")
      .eq("user_id", userId)
      .in("calendar_event_id", eventIds),
    supabaseAdmin
      .from("meeting_autojoin_exclusions")
      // `*` (not named columns) so the query still works while the `mode`
      // column migration is rolling out — a missing mode reads as "off".
      .select("*")
      .eq("user_id", userId)
      .in("calendar_event_id", eventIds),
  ]);

  const meetingByEvent = new Map<
    string,
    {
      id: string;
      status: string | null;
      recordingUrl: string | null;
      recallBotId: string | null;
      meetingUrl: string | null;
    }
  >();
  for (const r of meetingRows ?? []) {
    if (r.calendar_event_id) {
      meetingByEvent.set(r.calendar_event_id, {
        id: r.id,
        status: r.status ?? null,
        recordingUrl: r.recording_url ?? null,
        recallBotId: r.recall_bot_id ?? null,
        meetingUrl: r.meeting_url ?? null,
      });
    }
  }
  // An exclusion row keeps the bot out; its mode says why (off vs in-person).
  const exclusionModes = new Map<string, string>(
    (excludedRows ?? []).map((r) => [r.calendar_event_id, r.mode ?? "off"]),
  );

  const blocklist = await loadBlocklist(userId);
  const hasBlocklist = blocklist.emails.size > 0 || blocklist.domains.size > 0;

  return events
    .filter((e) => !!e.id)
    .map((e) => {
      const emails = hasBlocklist
        ? [...(e.attendees ?? []).map((a) => a.email), e.organizer?.email].filter(
            (addr): addr is string => !!addr,
          )
        : [];
      const blockedBy = hasBlocklist ? findBlockedEntry(emails, blocklist) : null;
      const exclusionMode = exclusionModes.get(e.id as string) ?? null;
      // A skipped color acts as a default "don't record" when the user hasn't
      // set an explicit per-event choice.
      const colorSkipped = exclusionMode === null && isColorSkipped(e, prefs);
      const recordMode: MeetingRecordMode =
        exclusionMode === "in_person"
          ? "in_person"
          : exclusionMode === "off" || colorSkipped
            ? "off"
            : "bot";
      const meeting = meetingByEvent.get(e.id as string) ?? null;
      const start = e.start?.dateTime ?? e.start?.date ?? null;
      const hasRecording =
        typeof meeting?.recordingUrl === "string" && meeting.recordingUrl.length > 0;
      return {
        id: e.id as string,
        title: e.summary ?? null,
        start,
        hasMeetingLink: !!extractMeetingUrl(e),
        scheduled: meeting !== null,
        excluded: exclusionMode !== null,
        recordMode,
        blocked: blockedBy !== null,
        blockedBy,
        declined: isDeclinedByUser(e),
        meetingId: meeting?.id ?? null,
        meetingStatus: meeting?.status ?? null,
        hasRecording,
        canResendBot: computeCanResendBot({
          recallBotId: meeting?.recallBotId ?? null,
          meetingUrl: meeting?.meetingUrl ?? null,
          status: meeting?.status ?? null,
          recordingUrl: meeting?.recordingUrl ?? null,
          scheduledStart: start,
        }),
      };
    });
}

/**
 * One calendar event in a wider window (past + future), annotated with the
 * linked meeting row (if any) and the resolved recording plan. Used by the
 * mobile calendar list and the web "recently missed" merge.
 */
export type CalendarWindowEvent = UpcomingCalendarEvent & {
  end: string | null;
  meetingId: string | null;
  meetingStatus: string | null;
  hasRecording: boolean;
  willRecord: boolean;
  skipReason: string | null;
};

/**
 * List an account's calendar events across a window that can reach into the
 * past (`daysBack`) and the future (`daysAhead`), each annotated with its
 * linked meeting row and a resolved recording plan (`willRecord` / `skipReason`).
 * Modeled on {@link listUpcomingCalendarEventsForAccount}; read-only, so it
 * never affects how {@link scheduleUpcomingMeetingBots} schedules bots.
 */
export async function listCalendarEventsWindow(
  accountId: string,
  userId: string,
  daysBack: number,
  daysAhead: number,
): Promise<CalendarWindowEvent[]> {
  const prefs = await loadEventFilterPrefs(userId);
  const events = (
    await fetchEventsInWindow(accountId, daysAhead * 24 * 60, daysBack * 24 * 60)
  ).filter((e) => !isHiddenEventType(e, prefs) && !isAllDayEvent(e) && !isColorSkipped(e, prefs));

  const eventIds = events.map((e) => e.id).filter((id): id is string => !!id);
  if (eventIds.length === 0) return [];

  const [{ data: meetingRows }, { data: excludedRows }, { data: acct }] = await Promise.all([
    supabaseAdmin
      .from("meetings")
      .select("id, calendar_event_id, status, recording_url, recall_bot_id, meeting_url")
      .eq("user_id", userId)
      .in("calendar_event_id", eventIds),
    supabaseAdmin
      .from("meeting_autojoin_exclusions")
      // `*` (not named columns) so the query still works while the `mode`
      // column migration is rolling out — a missing mode reads as "off".
      .select("*")
      .eq("user_id", userId)
      .in("calendar_event_id", eventIds),
    supabaseAdmin
      .from("gmail_accounts")
      .select("auto_record_meetings, record_declined_meetings")
      .eq("id", accountId)
      .maybeSingle(),
  ]);

  const meetingByEvent = new Map<
    string,
    {
      id: string;
      status: string | null;
      recordingUrl: string | null;
      recallBotId: string | null;
      meetingUrl: string | null;
    }
  >();
  for (const r of meetingRows ?? []) {
    if (r.calendar_event_id) {
      meetingByEvent.set(r.calendar_event_id, {
        id: r.id,
        status: r.status ?? null,
        recordingUrl: r.recording_url ?? null,
        recallBotId: r.recall_bot_id ?? null,
        meetingUrl: r.meeting_url ?? null,
      });
    }
  }
  const exclusionModes = new Map<string, string>(
    (excludedRows ?? []).map((r) => [r.calendar_event_id, r.mode ?? "off"]),
  );

  const autoRecord = !!acct?.auto_record_meetings;
  const recordDeclined = !!acct?.record_declined_meetings;

  const blocklist = await loadBlocklist(userId);
  const hasBlocklist = blocklist.emails.size > 0 || blocklist.domains.size > 0;

  return events
    .filter((e) => !!e.id)
    .map((e) => {
      const emails = hasBlocklist
        ? [...(e.attendees ?? []).map((a) => a.email), e.organizer?.email].filter(
            (addr): addr is string => !!addr,
          )
        : [];
      const blockedBy = hasBlocklist ? findBlockedEntry(emails, blocklist) : null;
      const exclusionMode = exclusionModes.get(e.id as string) ?? null;
      // A skipped color acts as a default "don't record" when there's no
      // explicit per-event choice.
      const colorSkipped = exclusionMode === null && isColorSkipped(e, prefs);
      const recordMode: MeetingRecordMode =
        exclusionMode === "in_person"
          ? "in_person"
          : exclusionMode === "off" || colorSkipped
            ? "off"
            : "bot";
      const hasMeetingLink = !!extractMeetingUrl(e);
      const blocked = blockedBy !== null;
      const declined = isDeclinedByUser(e);
      const meeting = meetingByEvent.get(e.id as string) ?? null;
      const hasRecording =
        typeof meeting?.recordingUrl === "string" && meeting.recordingUrl.length > 0;

      const willRecord =
        hasMeetingLink &&
        !blocked &&
        recordMode === "bot" &&
        autoRecord &&
        (recordDeclined || !declined);

      let skipReason: string | null = null;
      if (!willRecord) {
        if (!hasMeetingLink) skipReason = "no_link";
        else if (!autoRecord) skipReason = "auto_record_off";
        else if (declined && !recordDeclined) skipReason = "declined";
        else if (colorSkipped) skipReason = "color";
        else if (recordMode === "off") skipReason = "off";
        else if (recordMode === "in_person") skipReason = "in_person";
        else if (blocked) skipReason = "blocked";
      }

      const start = e.start?.dateTime ?? e.start?.date ?? null;
      return {
        id: e.id as string,
        title: e.summary ?? null,
        start,
        end: e.end?.dateTime ?? e.end?.date ?? null,
        hasMeetingLink,
        scheduled: meeting !== null,
        excluded: exclusionMode !== null,
        recordMode,
        blocked,
        blockedBy,
        declined,
        meetingId: meeting?.id ?? null,
        meetingStatus: meeting?.status ?? null,
        hasRecording,
        willRecord,
        skipReason,
        canResendBot: computeCanResendBot({
          recallBotId: meeting?.recallBotId ?? null,
          meetingUrl: meeting?.meetingUrl ?? null,
          status: meeting?.status ?? null,
          recordingUrl: meeting?.recordingUrl ?? null,
          scheduledStart: start,
        }),
      };
    });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when the error means the `mode` column hasn't been migrated yet. */
function isMissingModeColumn(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "PGRST204" ||
    error.code === "42703" ||
    /column.{0,24}mode|mode.{0,24}column/i.test(error.message ?? "")
  );
}

/**
 * Upsert one auto-join exclusion with its capture mode, on the caller's own
 * RLS-scoped client. If the `mode` column migration hasn't been applied yet,
 * fall back to a modeless upsert — the bot still stays out of the meeting;
 * the worst case is the in-person intent isn't remembered until it lands.
 * Returns null on success, or an error message.
 */
export async function upsertEventExclusion(
  supabase: SupabaseClient<Database>,
  entry: { userId: string; accountId: string; calendarEventId: string },
  mode: "off" | "in_person",
): Promise<string | null> {
  const row = {
    user_id: entry.userId,
    gmail_account_id: entry.accountId,
    calendar_event_id: entry.calendarEventId,
  };
  const { error } = await supabase
    .from("meeting_autojoin_exclusions")
    .upsert({ ...row, mode }, { onConflict: "user_id,calendar_event_id" });
  if (!error) return null;
  if (isMissingModeColumn(error)) {
    const { error: retryError } = await supabase
      .from("meeting_autojoin_exclusions")
      .upsert(row, { onConflict: "user_id,calendar_event_id" });
    return retryError ? retryError.message : null;
  }
  return error.message;
}

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
    .select(
      "id, user_id, email_address, auto_record_meetings, calendar_access, record_declined_meetings",
    )
    .eq("auto_record_meetings", true)
    .eq("calendar_access", true);

  // Cache each user's blocklist once per run (a user can have multiple accounts).
  const blocklistCache = new Map<string, Blocklist>();
  const prefsCache = new Map<string, EventFilterPrefs>();

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

    // Load the user's event-type/color capture preferences (cached per user).
    let prefs = prefsCache.get(account.user_id);
    if (!prefs) {
      prefs = await loadEventFilterPrefs(account.user_id);
      prefsCache.set(account.user_id, prefs);
    }

    for (const event of events) {
      if (!event.id) continue;
      // Never auto-join non-meeting entries (out-of-office, working location,
      // focus time, birthdays) or events tagged a color the user opted out of.
      if (isHiddenEventType(event, prefs) || isColorSkipped(event, prefs)) continue;
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

      // Skip meetings the user declined, unless they opted in to recording
      // declined meetings for this inbox.
      if (!account.record_declined_meetings && isDeclinedByUser(event)) {
        logInfo("meeting_autojoin_skipped_declined", {
          runId,
          accountId: account.id,
          eventId: event.id,
        });
        continue;
      }

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
      if (
        hasBlockedAttendee(
          participants.map((p) => p.email),
          blocklist,
        )
      ) {
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
          everyoneLeftTimeoutSec: botCfg.autoLeaveEnabled ? botCfg.autoLeaveMinutes * 60 : null,
          inCallNotRecordingTimeoutSec: botCfg.autoLeaveEnabled
            ? botCfg.autoLeaveMinutes * 60
            : null,
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
          await supabaseAdmin
            .from("meeting_participants")
            .insert(dedup.map((p) => ({ meeting_id: inserted.id, email: p.email, name: p.name })));
        }
        scheduled++;
      } catch (e) {
        logError(
          "meeting_autojoin_create_failed",
          { runId, accountId: account.id, eventId: event.id },
          e,
        );
      }
    }
  }

  logInfo("meeting_autojoin_done", { runId, scheduled });
  return { scheduled };
}
