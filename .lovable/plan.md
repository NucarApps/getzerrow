## Goal

Let users re-send the notetaker when a scheduled bot failed to join an upcoming or recently-started meeting. Auto-detect the failure state so the button only appears when it's actually useful.

## What counts as "bot failed to join"

A meeting row (source = `calendar`) is considered a failed/no-show when all of these hold:

- Has a `recall_bot_id` and a `meeting_url`.
- `status` is `failed`, OR `status` is a non-terminal state (`scheduled`, `joining`, `in_call`) and `scheduled_start` is more than 5 minutes in the past.
- Has no `recording_url` yet.
- The meeting hasn't ended more than 2 hours ago (recent-past cutoff; upcoming meetings are always eligible if their bot is `failed`).

This covers: (a) Recall never accepted the schedule, (b) bot got stuck in the waiting room, (c) auto-leave fired before anyone joined. It excludes finished meetings with a recording and stale rows from days ago.

## Backend

**New server fn `resendMeetingBot`** in `src/lib/meetings/recording.functions.ts`:

- Middleware: `requireSupabaseAuth`.
- Input: `{ id: string (uuid) }`.
- Load the meeting via `context.supabase` (RLS enforces ownership): `id, recall_bot_id, meeting_url, title, scheduled_start, status, recording_url, gmail_account_id`.
- Reject with a clear error if:
  - No `meeting_url` (nothing to send a bot to).
  - `recording_url` already present (already recorded).
  - `scheduled_start` more than 2h in the past (too late — meeting is over).
- Best-effort `leaveBot(old recall_bot_id)` so a stuck bot doesn't linger; swallow errors.
- Load `botCfg` via `loadBotConfig(userId)`.
- Call `createBot(...)` with the same shape used by `scheduleUpcomingMeetingBots`. Only pass `joinAt` when `scheduled_start` is still in the future; otherwise omit it so the new bot joins immediately.
- Update the meeting row: `recall_bot_id = new bot.id`, `status = "scheduled"` (or `"joining"` when joining now), clear `failure_reason` if that column exists, bump `updated_at`.
- Return `{ status, recallBotId }`.
- Wrap Recall calls in try/catch and surface a friendly error (`"Couldn't reach the meeting service. Try again in a moment."`) while `logError`-ing the raw cause.

Export from the `meetings.functions.ts` barrel is automatic (it re-exports the whole recording file).

**Extend `listCalendarEventsWindow`** (already returns `meetingStatus`, `hasRecording`, `end`, `start`) so the UI can derive a `canResendBot` flag. Add to the returned shape:

- `canResendBot: boolean` — computed with the rule above.

Also surface the same flag on `listAllUpcomingCalendarEvents` (the server fn feeding `UpcomingMeetingsCard`), which already builds on the window helper.

For "recent past meetings" that aren't on the calendar list (e.g. `source = "link"` recordings), extend the existing meetings list server fn used by the Meetings page (`listMeetings` / equivalent in `crud.functions.ts`) to include `canResendBot` too. Confirm the exact fn name when implementing.

## Frontend

**`UpcomingMeetingsCard`** (`src/components/meetings/UpcomingMeetingsCard.tsx`):

- When `e.canResendBot`, show a small `Resend notetaker` button beside the mode select (same 168px width, `variant="outline"`).
- Wire to a `useMutation` calling `resendMeetingBot({ data: { id: e.meetingId } })`.
- Optimistic: mark the row as `scheduled`, hide the resend button while pending.
- Toast on success ("Notetaker on its way") and error (message from thrown error).
- Invalidate `["upcoming-calendar-events"]`.

**Meetings page list** (`src/routes/_authenticated/meetings.tsx` + whichever row component it uses): show the same button on rows where `canResendBot` is true (recent past meetings that never got a recording). Same mutation, invalidate that page's meetings query.

Copy for the empty/failure hint under the title when `canResendBot` and no recording: `"Notetaker didn't join — try again."`

## Out of scope

- Changing the cron scheduler cadence or retry logic in `scheduleUpcomingMeetingBots`. This is a user-initiated retry, not an automated one.
- New DB columns (uses existing `status`, `recording_url`, `scheduled_start`).
- Blocklist re-check on resend — the original schedule already honored it, and the user explicitly chose to resend.

## Acceptance

- On an upcoming meeting whose bot is `failed`, `UpcomingMeetingsCard` shows a `Resend notetaker` button; clicking it creates a new Recall bot, updates `meetings.recall_bot_id`, and the row flips to `scheduled`.
- On a meeting that started 15 minutes ago with `status = "joining"` and no recording, the button appears on the Meetings page and, when clicked, sends a bot that joins immediately (no `joinAt`).
- On a finished meeting with a `recording_url`, the button never appears and calling the fn directly returns an error.
- On a meeting older than 2 hours with no recording, the button doesn't appear.
- The old bot (if reachable) is asked to leave before the new one is created; `leaveBot` failures are logged, not surfaced.
