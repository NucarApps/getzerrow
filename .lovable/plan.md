## Goal

Make the Upcoming list match expectations: an event tagged with a color you turned off (e.g. Basil / Benson Bokan) should disappear from the list entirely, and no all-day events should appear.

## What's happening now

Both the Meetings page Upcoming tab and the settings "Upcoming meetings" list are built by `listUpcomingCalendarEventsForAccount` in `src/lib/meetings-autojoin.server.ts`. That function only drops the four special event types (out-of-office, working location, focus time, birthdays). So:

- A color you switched off only gets marked "won't record" — it still shows.
- All-day entries pass straight through (they carry a `date` with no time).

## Changes

### 1. Hide color-skipped and all-day events from the list — `src/lib/meetings-autojoin.server.ts`

- Add a small helper `isAllDayEvent(event)` → true when `start.dateTime` is missing (only `start.date` present).
- In `listUpcomingCalendarEventsForAccount`, extend the existing filter so it also removes:
  - all-day events (`isAllDayEvent`)
  - color-skipped events (`isColorSkipped(e, prefs)`)

  These join the current `isHiddenEventType` filter.
- Apply the same two extra filters in `listCalendarEventsWindow` (the past+future window used by the "recently missed" merge and the mobile calendar list) so hidden colors and all-day events stay gone everywhere, not just the primary Upcoming tab.

Because color is now a hard hide, the `colorSkipped` branch that set `recordMode: "off"` becomes redundant for the list (those rows no longer render), but it's left in place as a harmless safety default.

### 2. Update the settings copy — `src/components/settings/MeetingEventFilterCard.tsx`

The "Record by event color" section currently says a color-off event just isn't recorded. Update the heading/description to reflect the new behavior: turning a color off hides those events from Upcoming and never records them. No logic change — the same `event_color_skip` preference now drives visibility too.

## Notes / scope

- The auto-join scheduler already skips color-tagged events for recording, and all-day events have no meeting link so they were never scheduled — no scheduler change needed.
- The settings "Upcoming meetings" card (`MeetingCalendarEventsCard`) reads the same server function, so it picks up both filters automatically.
- No database or migration changes; this reuses the existing `hidden_event_types` / `event_color_skip` preferences.

## Technical detail

```text
listUpcomingCalendarEventsForAccount / listCalendarEventsWindow
  fetch events
    .filter(e => !isHiddenEventType(e, prefs))   // existing
    .filter(e => !isAllDayEvent(e))              // new: drop all-day
    .filter(e => !isColorSkipped(e, prefs))      // new: drop skipped colors
```

`isAllDayEvent(e) = !e.start?.dateTime` (Google returns `start.date` for all-day, `start.dateTime` for timed events).
