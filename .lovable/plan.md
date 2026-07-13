## Goal

Three improvements to the Meetings page and its calendar handling:

1. Open the **Upcoming** tab by default.
2. Stop showing non-meeting calendar entries (out-of-office, working location, focus time, birthdays) in the list.
3. Give per-user controls to record/show or skip meetings **by calendar, by event type, and by event color** — in meeting settings.

## Part 1 — Default to the Upcoming tab

In `src/routes/_authenticated/meetings.tsx`, change the tabs default from `past` to `upcoming` (single line). The "Past meetings" tab stays available.

## Part 2 — Hide non-meeting entries (out-of-office / working location / focus time / birthdays)

Google marks these with an `eventType` other than `default`. Today we never read that field, so a "working from home" block shows up as an event.

- Request `eventType` and `colorId` in the calendar fetch (`fetchCalendarEvents` field list) and add both to the internal `UpcomingEvent` type in `src/lib/meetings-autojoin.server.ts`.
- Filter these types out of every list builder (`listUpcomingCalendarEventsForAccount`, `listCalendarEventsWindow`) and out of the auto-join scheduler loop, so they never appear and the notetaker never targets them.
- Which types are hidden is driven by the new per-user setting below (default hides out-of-office, working location, focus time, birthday).

## Part 3 — Record/show controls by calendar, event type, and event color

### 3a. Calendar (already exists, make it always reachable)
The "Calendars to record" card already lets you toggle each sub-calendar (personal vs main), and the Upcoming list already respects it. Today it only appears once auto-record is enabled. Change it to always render (when calendar access is granted) so you can pick which calendars show even with auto-record off, and reword it to say it controls what appears in Upcoming, not just recording.

### 3b. Event type + event color (new settings card)
Add one new "Event types & colors" card in the meeting settings drawer:

- **Event types**: toggles for out-of-office, working location, focus time, birthdays. Off = hidden from Upcoming and never recorded (all off by default). This is the direct control over the working-from-home entries.
- **Event colors**: the 11 Google Calendar colors (Tomato, Tangerine, Banana, Sage, Basil, Peacock, Blueberry, Lavender, Grape, Flamingo, Graphite) shown as labelled swatches, each with a record/don't-record toggle. A color set to "don't record" means meetings you've tagged that color are shown but the notetaker won't auto-join them; other colors record as normal (default: all record).

### How the rules combine
For each event we resolve a capture decision in this order:
1. Calendar not selected → hidden entirely.
2. Event type hidden → hidden entirely.
3. Per-event choice (existing "Send notetaker / Record in person / Don't record" dropdown) → always wins.
4. Otherwise fall back to the event's color rule (record vs skip).

Both the Upcoming list (`recordMode`/visibility flags) and the auto-join scheduler read the same resolved decision, so what you see matches what the bot does.

## Data model

Add columns to `meeting_bot_settings` (per-user, already used for notetaker settings):

- `hidden_event_types text[]` — default `{outOfOffice,workingLocation,focusTime,birthday}`.
- `event_color_skip text[]` — color IDs the notetaker should not auto-join (default empty = record all).

A single migration adds the columns; existing rows get the defaults. No new table needed.

## Technical notes

- New/extended server functions in `src/lib/meetings.functions.ts`: extend the bot-settings load/save (`getMeetingBotSettings`/`saveMeetingBotSettings` or equivalent) to include the two new fields; the calendar-selection functions are unchanged.
- `src/lib/meetings-autojoin.server.ts`: add `eventType`/`colorId` plumbing, a shared `resolveCaptureDecision` helper used by the list builders and the scheduler, and the type/color filtering. Filter engine and encryption paths are untouched.
- UI: reword/ungate `MeetingCalendarSelectCard.tsx`; add a new `MeetingEventFilterCard.tsx`; register it in `MeetingSettingsDrawer.tsx`. Colors render as Tailwind swatch chips (no inline styles).
- Mobile calendar API (`/api/mobile/meetings.ts`) already surfaces `record_mode`/`will_record`; it inherits the new filtering automatically since it uses the same server helpers.

## Out of scope
- No change to how recordings are transcribed/summarized.
- No change to the manual "Stop recording" / auto-leave behavior added earlier.