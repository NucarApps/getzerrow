// Google Calendar API helpers — direct calls to Google with per-user OAuth
// tokens. Server-only. Feeds the calendar cold-email guard: any attendee
// seen on the user's events in the last 12 months is stored in
// `calendar_contacts` and pinned to the inbox by the classifier.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getAccessToken } from "./google-oauth.server";
import { logError } from "./log.server";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const REQUEST_TIMEOUT_MS = 20_000;
// Bound a single sync run so one account can't hammer the Calendar API or
// stall the cron tick. A run that hits the cap simply resumes next tick.
const MAX_PAGES_PER_RUN = 12;
const PAGE_SIZE = 250;
const LOOKBACK_MONTHS = 12;

/** Coarse classification of why a Calendar API call failed, used by the UI to
 * show an accurate prompt instead of always asking the user to reconnect. */
export type CalendarErrorKind = "reconnect" | "api_disabled" | "rate_limited" | "unknown";

export class CalendarApiError extends Error {
  status: number;
  /** Google's machine-readable error reason (e.g. "accessNotConfigured"). */
  googleReason: string | null;
  constructor(message: string, status: number, googleReason: string | null = null) {
    super(message);
    this.name = "CalendarApiError";
    this.status = status;
    this.googleReason = googleReason;
  }

  /** Map status + Google reason to a coarse, user-facing kind. */
  get kind(): CalendarErrorKind {
    const reason = (this.googleReason ?? "").toLowerCase();
    if (
      reason.includes("accessnotconfigured") ||
      reason.includes("service_disabled") ||
      reason === "servicedisabled"
    ) {
      return "api_disabled";
    }
    if (this.status === 401 || reason.includes("scope") || reason.includes("insufficientpermissions")) {
      return "reconnect";
    }
    if (this.status === 429 || reason.includes("ratelimit") || reason.includes("quota")) {
      return "rate_limited";
    }
    return "unknown";
  }
}

/** Pull Google's first error `reason` (and surface `status`) out of an error body. */
function parseGoogleReason(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: { status?: string; errors?: Array<{ reason?: string }> };
    };
    return parsed.error?.errors?.[0]?.reason ?? parsed.error?.status ?? null;
  } catch {
    return null;
  }
}

type CalendarAttendee = { email?: string; self?: boolean; responseStatus?: string; displayName?: string };

type CalendarEvent = {
  attendees?: CalendarAttendee[];
  organizer?: { email?: string; self?: boolean; displayName?: string };
  creator?: { email?: string; self?: boolean; displayName?: string };
  summary?: string;
  start?: { dateTime?: string; date?: string };
};

type EventsResponse = {
  items?: CalendarEvent[];
  nextPageToken?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Pure parser: extract every distinct attendee/organizer email address from a
 * single calendar event, excluding the account owner's own address and any
 * resource/room addresses. Lowercased. Kept pure so it stays unit-testable.
 */
export function extractAttendeeEmails(event: CalendarEvent, selfEmail: string): string[] {
  const self = selfEmail.toLowerCase();
  const out = new Set<string>();
  const consider = (raw: string | undefined, isSelf: boolean | undefined) => {
    if (!raw || isSelf) return;
    const email = raw.toLowerCase().trim();
    if (email === self) return;
    // Skip Google resource calendars (meeting rooms, equipment).
    if (email.endsWith(".calendar.google.com") || email.includes("resource.calendar")) return;
    if (!EMAIL_RE.test(email)) return;
    out.add(email);
  };
  for (const a of event.attendees ?? []) consider(a.email, a.self);
  consider(event.organizer?.email, event.organizer?.self);
  consider(event.creator?.email, event.creator?.self);
  return [...out];
}

/** A person seen on a calendar event, with the best name + meeting metadata we have. */
export type CalendarPerson = {
  email: string;
  name: string | null;
  meetingAt: string | null;
  eventTitle: string | null;
};

/**
 * Pure parser: extract distinct attendees/organizers from one event, keeping
 * each person's display name (when present), the event start time, and the
 * event title. Excludes the account owner and resource/room calendars.
 * Lowercased emails. Kept pure so it stays unit-testable.
 */
export function extractAttendeePeople(event: CalendarEvent, selfEmail: string): CalendarPerson[] {
  const self = selfEmail.toLowerCase();
  const meetingAt = event.start?.dateTime ?? event.start?.date ?? null;
  const eventTitle = event.summary?.trim() || null;
  const out = new Map<string, CalendarPerson>();
  const consider = (raw: string | undefined, isSelf: boolean | undefined, displayName: string | undefined) => {
    if (!raw || isSelf) return;
    const email = raw.toLowerCase().trim();
    if (email === self) return;
    if (email.endsWith(".calendar.google.com") || email.includes("resource.calendar")) return;
    if (!EMAIL_RE.test(email)) return;
    const name = displayName?.trim() || null;
    const existing = out.get(email);
    if (!existing) {
      out.set(email, { email, name, meetingAt, eventTitle });
    } else if (name && !existing.name) {
      existing.name = name;
    }
  };
  for (const a of event.attendees ?? []) consider(a.email, a.self, a.displayName);
  consider(event.organizer?.email, event.organizer?.self, event.organizer?.displayName);
  consider(event.creator?.email, event.creator?.self, event.creator?.displayName);
  return [...out.values()];
}

async function calendarFetch<T>(accountId: string, path: string): Promise<T> {
  const token = await getAccessToken(accountId);
  let res: Response;
  try {
    res = await fetch(`${CALENDAR_BASE}${path}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new CalendarApiError(`Calendar API network error on ${path}: ${msg}`, 0);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new CalendarApiError(
      `Calendar API ${res.status} on ${path}: ${text.slice(0, 300)}`,
      res.status,
      parseGoogleReason(text),
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** One page of primary-calendar events with attendees, newest first. */
async function listEventsPage(
  accountId: string,
  timeMin: string,
  pageToken?: string,
): Promise<EventsResponse> {
  const params = new URLSearchParams({
    timeMin,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(PAGE_SIZE),
    showDeleted: "false",
  });
  if (pageToken) params.set("pageToken", pageToken);
  return calendarFetch<EventsResponse>(
    accountId,
    `/calendars/primary/events?${params.toString()}`,
  );
}

/**
 * Sync attendees from the account's calendar (last 12 months) into
 * `calendar_contacts`. Upserts on (gmail_account_id, email_address) and
 * refreshes last_seen_at. Returns the number of distinct contacts written.
 * Throws CalendarApiError (e.g. 403 when calendar scope is missing) so the
 * caller can surface a reconnect prompt.
 */
export async function syncCalendarContacts(
  accountId: string,
  userId: string,
): Promise<{ contacts: number; pages: number; truncated: boolean }> {
  const { data: account } = await supabaseAdmin
    .from("gmail_accounts")
    .select("email_address")
    .eq("id", accountId)
    .maybeSingle();
  const selfEmail = account?.email_address ?? "";

  const timeMin = new Date(
    Date.now() - LOOKBACK_MONTHS * 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const emails = new Map<string, string>(); // email -> last_seen_at iso (now)
  const now = new Date().toISOString();
  let pageToken: string | undefined;
  let pages = 0;
  let truncated = false;

  try {
    do {
      const page = await listEventsPage(accountId, timeMin, pageToken);
      for (const ev of page.items ?? []) {
        for (const email of extractAttendeeEmails(ev, selfEmail)) {
          emails.set(email, now);
        }
      }
      pageToken = page.nextPageToken;
      pages++;
      if (pages >= MAX_PAGES_PER_RUN && pageToken) {
        truncated = true;
        break;
      }
    } while (pageToken);
  } catch (e) {
    // Persist a human-readable reason so the UI can show what actually went
    // wrong (e.g. Calendar API disabled) instead of always prompting reconnect.
    await supabaseAdmin
      .from("gmail_accounts")
      .update({ calendar_sync_error: describeCalendarError(e) })
      .eq("id", accountId);
    throw e;
  }

  if (emails.size > 0) {
    const rows = [...emails.keys()].map((email_address) => ({
      user_id: userId,
      gmail_account_id: accountId,
      email_address,
      last_seen_at: now,
    }));
    const { error } = await supabaseAdmin
      .from("calendar_contacts")
      .upsert(rows, { onConflict: "gmail_account_id,email_address" });
    if (error) {
      logError("calendar.upsert_failed", { account_id: accountId, user_id: userId, count: rows.length }, error);
    }
  }

  // Success: stamp the sync time and clear any stored error.
  await supabaseAdmin
    .from("gmail_accounts")
    .update({ calendar_synced_at: now, calendar_sync_error: null })
    .eq("id", accountId);

  return { contacts: emails.size, pages, truncated };
}

/** Short, user-facing explanation of a calendar sync failure. */
export function describeCalendarError(e: unknown): string {
  if (e instanceof CalendarApiError) {
    switch (e.kind) {
      case "api_disabled":
        return "The Google Calendar API isn't enabled for this connection yet. This is a one-time setup in Google Cloud — once enabled, syncing will work.";
      case "reconnect":
        return "Calendar access is missing or expired. Reconnect Google to grant calendar access.";
      case "rate_limited":
        return "Google is rate-limiting calendar requests right now. Try again in a few minutes.";
      default:
        return "Couldn't reach Google Calendar. Please try again shortly.";
    }
  }
  return "Couldn't sync your calendar. Please try again.";
}
