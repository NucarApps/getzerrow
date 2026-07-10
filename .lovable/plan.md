# Per-calendar recording selection

## Goal
Today each connected email has one on/off recording toggle, and Zerrow only ever reads that email's **primary** Google Calendar. This adds a second level: once recording is ON for an email, the user can pick **which calendars** under that email (e.g. a main work calendar and a personal calendar) are recorded and shown.

Decided behavior:
- When recording is turned on for an email, only the **primary** calendar is selected by default.
- A calendar's selection controls **both** what shows in the meetings/upcoming lists **and** what the notetaker records. Unselected calendars are fully ignored.

## What the user sees
In Meeting settings, under each email that has recording turned on, a new "Calendars" section lists every calendar Google reports for that email, each with a toggle:

```text
Auto-record meetings            shawn@nucar.com        [ON]
  Calendars to record
   ▸ shawn@nucar.com (Main)                            [ON]
   ▸ Personal                                          [OFF]
   ▸ Team Holidays                                     [OFF]
```

Turning a calendar on/off immediately changes which meetings appear in Upcoming meetings and which the notetaker joins. When recording is off for the email, the calendar list is hidden/disabled.

## How it works

### 1. Store the selection (new table)
New table `meeting_calendar_selections`:
- `user_id`, `gmail_account_id`, `calendar_id` (Google calendar id), `calendar_summary` (display name cache), `enabled` (bool)
- unique on `(gmail_account_id, calendar_id)`
- RLS scoped to `auth.uid()`, plus `service_role` grant (cron/bot scheduler reads it).

Fallback rule: if an account has **no** rows yet, the app treats it as "primary calendar only" so existing users keep working unchanged. Rows get written the first time the user opens the calendar list or toggles a calendar.

### 2. Read the list of calendars
Add a server helper to fetch Google's `calendarList` for an account (same OAuth token/scope already used for calendar reads). A new authenticated server function `listAccountCalendars({ accountId })` returns each calendar (`id`, `summary`, `primary`) merged with its stored `enabled` state (primary defaults to on when nothing is stored).

A companion `setCalendarEnabled({ accountId, calendarId, calendarSummary, enabled })` upserts a row.

### 3. Record/list only selected calendars
- Generalize `fetchEventsInWindow` in `src/lib/meetings-autojoin.server.ts` to take a `calendarId` (defaults to `primary`), and add a helper that resolves an account's selected calendar ids (stored enabled rows, or `["primary"]` fallback).
- `listUpcomingCalendarEventsForAccount` and `listCalendarEventsWindow` fetch across all selected calendars and merge results (dedupe by event id).
- `scheduleUpcomingMeetingBots` iterates each account's selected calendars instead of only primary. This is the one intentional change to bot scheduling — required so "which calendar I want to record" is honored. The rest of its logic (blocklist, declined, exclusions, dedupe on `calendar_event_id`) is unchanged.

### 4. UI
New `MeetingCalendarSelectCard` component rendered in `MeetingSettingsDrawer` (and any settings surface using these cards) directly under `MeetingAutoRecordCard`, per account:
- Uses React Query + `useServerFn`, following the existing card patterns.
- Lists calendars with shadcn `Switch` toggles, optimistic update, disabled when recording is off or calendar access is missing.
- Invalidates the `calendar-events` / upcoming queries on change so lists refresh.

## Technical notes
- New endpoints are authenticated server functions in `src/lib/meetings.functions.ts` using `requireSupabaseAuth`; the scheduler reads selections via `supabaseAdmin` inside the existing server-only module.
- No new OAuth scope needed — `calendarList.list` works with the calendar scope already granted.
- Event ids are globally unique across a user's calendars, so `meetings.calendar_event_id` and `meeting_autojoin_exclusions` need no schema change.
- Backwards compatible: accounts with no selection rows behave exactly as today (primary only).

## Out of scope
- No change to how a scheduled bot is created/configured (name, avatar, chat), the blocklist, declined handling, or the per-event skip toggles — those keep working as they do now.
