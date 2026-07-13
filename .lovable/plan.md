# Stop stuck meetings: manual button + auto force-leave

## Problem
A bot-recorded meeting can get stuck showing "Recording in progress" long after it actually ended, because Recall never sent the "call ended" signal. Today the only actions are Refresh (re-polls the same stuck state) and Delete (throws the meeting away). There's no way to force the bot out and finalize the recording.

## Goal
1. A manual **Stop recording** control that force-leaves the bot and finalizes the meeting on demand.
2. An automatic safety net: Recall leaves on its own when no humans remain, plus a cron backstop that force-leaves bots stuck past a configurable timeout. **Default: enabled, 30 minutes.**

---

## Part A — Manual "Stop recording"

### Server function `stopMeeting` (`src/lib/meetings.functions.ts`)
- Auth-scoped (`requireSupabaseAuth`), input `{ id: uuid }`.
- Load the meeting via the RLS client (`id, recall_bot_id, status`). RLS enforces ownership.
- If already terminal (`done`/`failed`) or no `recall_bot_id`, return current status (no-op).
- Dynamically `import("./recall.server")` and call `leaveBot(recall_bot_id)` best-effort (it already swallows 400/404).
- Set status to `processing`/`recording`→ then run `syncMeetingFromRecall(meeting)` (dynamic import of `./meetings.server`) to immediately pull the finalized recording/transcript/summary.
- Return the resolved status. Keeps all service-role/Recall code server-only via dynamic imports.

### UI (`src/routes/_authenticated/meetings.tsx`)
- Add `stopMeeting` via `useServerFn`, plus a `stopping` state and confirmation dialog.
- In the "Recording in progress" block (~line 1425), add a destructive **Stop recording** button next to **Refresh status**, shown only for bot meetings (`meeting.recall_bot_id` / `meeting.meeting_url` present). In-person/local recordings don't get it.
- On confirm: call `stopMeeting({ data: { id } })`, then re-fetch the meeting so the sheet flips to the finalized view.
- Also surface a compact **Stop** action on non-terminal past-meeting rows for quick access.

---

## Part B — Auto force-leave (opt-in, on by default)

### DB migration — add two columns to `public.meeting_bot_settings`
- `auto_leave_enabled boolean NOT NULL DEFAULT true`
- `auto_leave_minutes integer NOT NULL DEFAULT 30`
- (Existing rows pick up defaults; grants/RLS already exist on the table.)

### Recall bot config (`src/lib/recall.server.ts`)
- Extend `CreateBotInput` with `everyoneLeftTimeoutSec?` and `inCallNotRecordingTimeoutSec?`.
- When provided, add to the bot body:
  ```
  automatic_leave: {
    everyone_left_timeout: <sec>,
    in_call_not_recording_timeout: <sec>,
  }
  ```
  so Recall itself ends the recording when no humans remain for the configured window.

### Bot config plumbing (`src/lib/meetings.server.ts`)
- Extend `BotConfig` + `loadBotConfig` to read `auto_leave_enabled, auto_leave_minutes` (fallback: enabled, 30).
- In `recordFromLink` (and any calendar auto-join path that calls `createBot`), pass the timeout seconds when `auto_leave_enabled` is true.

### Settings UI (`src/components/settings/MeetingBotCard.tsx`)
- Add a **Automatically leave empty meetings** switch (default on) and a minutes input (default 30, min 5), wired into the existing save flow.
- Update `getMeetingBotSettings` / `updateMeetingBotSettings` (`src/lib/meetings.functions.ts`) to read/write the two new fields (validate minutes 5–240).

### Cron backstop (`src/routes/api/public/hooks/reconcile-meetings.ts`)
- For meetings still in `joining`/`recording` whose `started_at` (fallback `scheduled_start`/`created_at`) is older than the user's `auto_leave_minutes` + a small grace margin, call `leaveBot` before `syncMeetingFromRecall`. This guarantees the timeout is honored even if Recall's own detection misses. Uses `supabaseAdmin` + `loadBotConfig(user_id)` — already the unauthenticated cron context.

---

## Technical notes
- No changes to the encryption/token path or filter engine.
- `leaveBot` and `syncMeetingFromRecall` stay behind dynamic `import()` in `*.functions.ts` so service-role code never enters the client bundle.
- Recording finalization reuses the existing `syncMeetingFromRecall` pipeline, so transcript/summary/recording population is unchanged.
