## Goal

Right now the notetaker sends a bot to every upcoming calendar event that has a meeting link, ignoring your RSVP. We'll make it respect your response status:

- **Default:** skip meetings you've declined (or haven't accepted responses aside — only explicit "declined" is skipped, so tentative/no-response still records as today).
- **New opt-in per inbox:** "Record meetings I've declined." When on, the notetaker joins declined meetings too — so it records even when you're not attending.
- The upcoming-meetings list marks declined events so you can see them and understand what will/won't be recorded.

## What changes

### 1. Database
Add one column to the Gmail account (inbox) record:
- `record_declined_meetings` — boolean, defaults to off (`false`).

### 2. Scheduler (backend auto-join logic)
In the routine that schedules bots for upcoming meetings:
- Read each attendee's RSVP status from the calendar event (Google returns your own status on the event's attendee entry marked `self`).
- Add a helper that returns whether *you* declined the event.
- When an event is declined by you **and** the inbox's `record_declined_meetings` is off → skip it (with a log line, same as the existing blocklist skip).
- When the toggle is on → schedule the bot as normal.
- Organizer-only events (where you aren't listed as an attendee) are treated as not declined, so nothing changes for those.

### 3. Upcoming-meetings list (backend read)
The function that lists the next 14 days of events per inbox will add a `declined` flag to each event, and the per-account list response will also report the inbox's current `record_declined_meetings` setting so the UI can show accurate "will record / skipped" state.

### 4. Server functions
- Extend the auto-record status function to also return `recordDeclined`.
- Add a `setRecordDeclined` function to flip the new per-inbox toggle (auth-scoped, RLS-checked like the existing `setAutoRecord`).

### 5. Settings UI
- **Auto-record card:** add a second switch under the main auto-record toggle — "Record meetings I've declined" with a short helper line ("Send the notetaker even to meetings you've declined or aren't attending."). It's enabled only when auto-record is on and calendar access is granted; it defaults to off.
- **Upcoming meetings card:** show a small "Declined" badge on declined events, and reflect whether each will be recorded based on the new setting (a declined event shows as skipped when the toggle is off, and as scheduled when it's on), while still respecting per-meeting exclusions and the don't-record blocklist.

## Notes
- No change to how tentative or unanswered meetings are handled — only explicit declines are affected.
- Fully backward compatible: existing inboxes get the toggle off, meaning declined meetings that used to be recorded will now be skipped by default (the requested behavior); users who want the old behavior flip the new switch on.

### Technical details
- Migration adds `record_declined_meetings boolean not null default false` to `public.gmail_accounts` (no new grants/policies needed — column on an existing table).
- `src/lib/meetings-autojoin.server.ts`: add `responseStatus` to the attendee shape in `UpcomingEvent`; add `isDeclinedByUser(event)`; include `record_declined_meetings` in the account select inside `scheduleUpcomingMeetingBots` and skip declined events unless enabled; add `declined` to `UpcomingCalendarEvent` and populate it in `listUpcomingCalendarEventsForAccount`.
- `src/lib/meetings.functions.ts`: return `recordDeclined` from `getAutoRecordStatus`; return `recordDeclined` alongside events from `listUpcomingCalendarEvents`; add `setRecordDeclined` server fn updating `gmail_accounts.record_declined_meetings`.
- `src/components/settings/MeetingAutoRecordCard.tsx`: add the declined toggle wired to `setRecordDeclined` + `getAutoRecordStatus`.
- `src/components/settings/MeetingCalendarEventsCard.tsx`: add declined badge and factor `declined` + `recordDeclined` into the send/skip display.