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

/** One calendar under an account, with its current recording selection. */
export type AccountCalendar = {
  id: string;
  summary: string | null;
  primary: boolean;
  enabled: boolean;
};

/**
 * List every Google calendar under one account, merged with the stored
 * per-calendar recording selection. When nothing is stored yet, the primary
 * calendar defaults to on and all others off (backwards compatible).
 */
export const listAccountCalendars = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ accountId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: acct } = await context.supabase
      .from("gmail_accounts")
      .select("calendar_access")
      .eq("id", data.accountId)
      .maybeSingle();
    if (!acct) throw new Error("Account not found");
    if (!acct.calendar_access) {
      return { calendarAccess: false, calendars: [] as AccountCalendar[] };
    }

    const { data: selections } = await context.supabase
      .from("meeting_calendar_selections")
      .select("calendar_id, enabled")
      .eq("gmail_account_id", data.accountId);
    const hasSelections = !!selections && selections.length > 0;
    const enabledById = new Map<string, boolean>(
      (selections ?? []).map((r) => [r.calendar_id, r.enabled]),
    );

    const { listGoogleCalendars } = await import("../meetings-autojoin.server");
    try {
      const calendars = await listGoogleCalendars(data.accountId);
      return {
        calendarAccess: true,
        calendars: calendars.map((c) => ({
          id: c.id,
          summary: c.summary,
          primary: c.primary,
          // No stored rows yet → primary on by default, others off.
          enabled: hasSelections ? (enabledById.get(c.id) ?? false) : c.primary,
        })),
      };
    } catch (e) {
      logError(
        "meeting_list_calendars_failed",
        { accountId: data.accountId, userId: context.userId },
        e,
      );
      return {
        calendarAccess: true,
        calendars: [] as AccountCalendar[],
        error: "Couldn't load your calendars right now.",
      };
    }
  });

/**
 * Persist the full per-calendar recording selection for one account. The UI
 * always sends every calendar's current state, so the stored rows stay a
 * complete, consistent snapshot (no implicit "primary on" gaps once rows
 * exist). Upserts on (gmail_account_id, calendar_id).
 */
export const saveCalendarSelections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        accountId: z.string().uuid(),
        calendars: z
          .array(
            z.object({
              calendarId: z.string().min(1),
              calendarSummary: z.string().nullable().optional(),
              enabled: z.boolean(),
            }),
          )
          .min(1),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    // Confirm the account belongs to the caller (RLS-scoped read).
    const { data: acct } = await context.supabase
      .from("gmail_accounts")
      .select("id")
      .eq("id", data.accountId)
      .maybeSingle();
    if (!acct) throw new Error("Account not found");

    const rows = data.calendars.map((c) => ({
      user_id: context.userId,
      gmail_account_id: data.accountId,
      calendar_id: c.calendarId,
      calendar_summary: c.calendarSummary ?? null,
      enabled: c.enabled,
    }));
    const { error } = await context.supabase
      .from("meeting_calendar_selections")
      .upsert(rows, { onConflict: "gmail_account_id,calendar_id" });
    if (error) throw new Error(error.message);
    return { saved: rows.length };
  });

type UpcomingCalendarEvent = import("../meetings-autojoin.server").UpcomingCalendarEvent;

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
    const { listUpcomingCalendarEventsForAccount } = await import("../meetings-autojoin.server");
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

/** A calendar-enabled inbox whose events couldn't be read until it's reconnected. */
export type CalendarAccountNeedingReconnect = {
  id: string;
  email: string | null;
};

/**
 * List upcoming calendar events (next 14 days) across all of the caller's
 * calendar-enabled inboxes, merged into one time-sorted list so the meetings
 * page can show what the notetaker will join. Per-account Google failures are
 * logged and skipped so one bad inbox doesn't break the whole list; inboxes
 * that need reconnecting are surfaced separately so the UI can prompt for it
 * instead of silently dropping their meetings.
 */
export const listAllUpcomingCalendarEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: accounts } = await context.supabase
      .from("gmail_accounts")
      .select("id, email_address, calendar_access, needs_reconnect")
      .eq("calendar_access", true)
      .eq("auto_record_meetings", true);

    if (!accounts || accounts.length === 0) {
      return {
        calendarAccess: false,
        events: [] as UpcomingCalendarEventWithAccount[],
        accountsNeedingReconnect: [] as CalendarAccountNeedingReconnect[],
      };
    }

    const { NeedsReconnectError } = await import("../google-oauth.server");
    const { listUpcomingCalendarEventsForAccount } = await import("../meetings-autojoin.server");
    const events: UpcomingCalendarEventWithAccount[] = [];
    const accountsNeedingReconnect: CalendarAccountNeedingReconnect[] = [];
    for (const acct of accounts) {
      // Known-stale inbox: don't even try to read it — surface the reconnect
      // prompt so its meetings don't just vanish from the list.
      if (acct.needs_reconnect) {
        accountsNeedingReconnect.push({ id: acct.id, email: acct.email_address ?? null });
        continue;
      }
      try {
        const accountEvents = await listUpcomingCalendarEventsForAccount(acct.id, context.userId);
        for (const e of accountEvents) {
          events.push({ ...e, accountId: acct.id, accountEmail: acct.email_address ?? null });
        }
      } catch (e) {
        // A dead OAuth grant surfaces as a reconnect prompt; anything else is
        // a transient failure we just log and skip.
        if (e instanceof NeedsReconnectError) {
          accountsNeedingReconnect.push({ id: acct.id, email: acct.email_address ?? null });
        } else {
          logError(
            "meeting_list_all_events_failed",
            { accountId: acct.id, userId: context.userId },
            e,
          );
        }
      }
    }

    events.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
    return { calendarAccess: true, events, accountsNeedingReconnect };
  });

type CalendarWindowEvent = import("../meetings-autojoin.server").CalendarWindowEvent;

/** A recent calendar event (last 7 days) with no meeting row, annotated with
 *  the inbox it came from so the meetings page can show why it wasn't recorded. */
export type RecentUnrecordedEvent = CalendarWindowEvent & {
  accountId: string;
  accountEmail: string | null;
};

/**
 * List the caller's calendar events from the last 7 days that never got a
 * meeting row (across all calendar-enabled inboxes), so the meetings page can
 * surface meetings that happened but weren't recorded, with the reason. Purely
 * read-only — it never changes how the bot scheduler works.
 */
export const listRecentUnrecordedEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: accounts } = await context.supabase
      .from("gmail_accounts")
      .select("id, email_address, calendar_access, needs_reconnect")
      .eq("calendar_access", true)
      .eq("auto_record_meetings", true);

    if (!accounts || accounts.length === 0) {
      return { events: [] as RecentUnrecordedEvent[] };
    }

    const { NeedsReconnectError } = await import("../google-oauth.server");
    const { listCalendarEventsWindow } = await import("../meetings-autojoin.server");
    const events: RecentUnrecordedEvent[] = [];
    for (const acct of accounts) {
      if (acct.needs_reconnect) continue;
      try {
        const accountEvents = await listCalendarEventsWindow(acct.id, context.userId, 7, 0);
        for (const e of accountEvents) {
          // Only events that never produced a meeting row — recorded ones
          // already show up in the past meetings list.
          if (e.meetingId) continue;
          events.push({ ...e, accountId: acct.id, accountEmail: acct.email_address ?? null });
        }
      } catch (e) {
        if (!(e instanceof NeedsReconnectError)) {
          logError(
            "meeting_list_recent_unrecorded_failed",
            { accountId: acct.id, userId: context.userId },
            e,
          );
        }
      }
    }

    events.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
    return { events };
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
      const { upsertEventExclusion } = await import("../meetings-autojoin.server");
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
      const { upsertEventExclusion } = await import("../meetings-autojoin.server");
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
