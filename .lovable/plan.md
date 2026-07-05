# Show upcoming calendar events on the Meetings page

Add a section at the top of the Meetings page that lists the calendar meetings coming up in the next 14 days (across every connected Gmail inbox), so you can see what the notetaker will join and flip it off for any meeting you'd rather keep private.

## What you'll see

- A new "Upcoming meetings" card above the list of recorded meetings.
- One combined, time-sorted list merging events from all your connected inboxes (only meetings that have a Zoom, Meet, or Teams link).
- Each row shows the title, start time, platform, which inbox it's from (when you have more than one), and a "Send notetaker / Skipped" toggle.
- Toggling off writes an exclusion so auto-record skips that meeting; toggling back on re-includes it. Same behavior as today's Settings control, just surfaced on the Meetings page.
- Graceful empty/edge states: nothing with a meeting link, no calendar access yet, or no connected inboxes.

```text
Meetings
────────────────────────────
Upcoming meetings
  ▸ Weekly sync        Mon 9:00 AM · Google Meet · you@work.com   [ Send notetaker ● ]
  ▸ Client call        Tue 2:30 PM · Zoom · you@personal.com      [ Skipped        ○ ]
────────────────────────────
Recorded meetings
  ▸ ... (existing list)
```

## How it works (technical)

### New server function — `src/lib/meetings.functions.ts`
- Add `listAllUpcomingCalendarEvents` (GET, `requireSupabaseAuth`, no input).
- It loads the caller's Gmail accounts that have `calendar_access = true` (RLS-scoped `context.supabase`), then for each calls the existing `listUpcomingCalendarEventsForAccount(accountId, userId)` helper from `meetings-autojoin.server.ts`.
- Per-account Google failures are caught and logged (via `logError`) and skipped, so one bad inbox doesn't break the list — same resilience pattern as `listMeetingPeople`.
- Returns a flat array of events, each annotated with `accountId` and `accountEmail`, plus a `calendarAccess` flag (false when no account has calendar access). Events are merged and sorted soonest-first.
- Reuse the existing `setEventExclusion` server function unchanged for the toggle.

### New component — `src/components/meetings/UpcomingMeetingsCard.tsx`
- Modeled on `MeetingCalendarEventsCard`, but account-agnostic: it calls `listAllUpcomingCalendarEvents` (query key `["upcoming-calendar-events"]`), filters to events with `hasMeetingLink`, and renders the combined list.
- Optimistic toggle via a `useMutation` calling `setEventExclusion({ data: { accountId: e.accountId, calendarEventId: e.id, excluded } })`, with rollback on error and invalidation on settle — mirroring the existing card's mutation.
- Shows the inbox email per row only when events span more than one account.
- Handles loading, no-calendar-access, and empty states with friendly copy.

### Wire into the page — `src/routes/_authenticated/meetings.tsx`
- Render `<UpcomingMeetingsCard />` between the page header and the recorded-meetings list. No changes to the existing recorded-meetings list, detail drawer, or record dialog.

## Notes
- No database or schema changes; reuses the existing `meeting_autojoin_exclusions` table and `setEventExclusion`.
- The toggle only affects auto-record scheduling (as it does today); it doesn't cancel a bot that's already scheduled — consistent with current behavior. I can extend it to that later if you want.
