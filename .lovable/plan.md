# Reflect the don't-record list in the Upcoming meetings list

## Problem
The Upcoming meetings list (both the Meetings page card and the Settings calendar card) shows a "Send notetaker" toggle for every meeting and lets you turn it on even when a guest is on your don't-record list. The background scheduler already refuses to record those meetings, but the UI is misleading — it looks like recording is enabled.

## Goal
Meetings that include a blocked guest appear clearly marked as blocked in the Upcoming list, with the toggle forced off and disabled so you can't turn recording on for them.

## How it will work
- Each upcoming meeting is checked against your don't-record list (attendee + organizer emails, by exact email or whole domain).
- A blocked meeting shows a small "Blocked" label instead of "Send notetaker", the toggle is off and greyed out, and a short line explains why (e.g. "Guest on your don't-record list").
- Everything else behaves as before.

---

## Technical details

### 1. Compute `blocked` server-side
In `src/lib/meetings-autojoin.server.ts`:
- Add `blocked: boolean` and `blockedBy: string | null` to the `UpcomingCalendarEvent` type.
- In `listUpcomingCalendarEventsForAccount`, load the user's blocklist once (`loadBlocklist`), and for each event run the existing `findBlockedEntry` over its attendee + organizer emails. Set `blocked`/`blockedBy` on each returned event. (`findBlockedEntry` already exists in this file; no new matching logic.)
- Since `fetchEventsInWindow` already returns `attendees` and `organizer`, no extra calendar calls are needed.

### 2. Surface it in both cards
`UpcomingCalendarEvent` flows through `meetings.functions.ts` unchanged (type re-export), so both consumers get the new fields.

In `src/components/meetings/UpcomingMeetingsCard.tsx` and `src/components/settings/MeetingCalendarEventsCard.tsx`:
- When `e.blocked`: render the status text as "Blocked" (muted), set `<Switch checked={false} disabled>`, and add a small helper line under the title like "Guest on your don't-record list — won't be recorded." Keep the existing behavior for non-blocked events.
- Guard the toggle handler so a blocked row can't fire the mutation.

### 3. No schema or server-function signature changes
Only the returned event shape gains two fields; `setEventExclusion` is untouched. The scheduler-side skip already exists and stays as the enforcement backstop.

### Verification
- `tsgo --noEmit` clean.
- With a blocked attendee on an upcoming event, that row shows "Blocked", the toggle is off and disabled, and clicking it does nothing; other rows still toggle normally.
