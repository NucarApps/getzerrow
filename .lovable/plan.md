## Problem

Clicking play on a finished meeting does nothing. Root causes, in order of impact:

1. **Inline playback is blocked.** The player is `<video src={recording_url} controls />` with no `playsInline`. The preview runs inside an iframe, and on a narrow/mobile viewport the browser wants to hand off to fullscreen playback, which is blocked in the iframe — so the tap appears to do nothing.
2. **Fragile source.** The S3 file is served as `binary/octet-stream` (not `video/mp4`) and there's no `<source type>` hint or fallback link, so any browser that's strict about MIME type silently fails.
3. **The signed URL expires.** Recall's recording URL is a short-lived signed S3 link (this meeting's expires ~6h after it ended). We store it once at completion, so re-opening the meeting later loads a dead URL and playback breaks again — even though the recording still exists on Recall.
4. **Missing transcript/summary.** For the existing finished meeting, `transcript` and `summary` are `null` (captions weren't ready the instant it hit "done"), and nothing re-pulls them for an already-`done` meeting.

## Fix

### 1. Make the player actually play (frontend)
In the meeting detail dialog, update the `<video>`:
- Add `playsInline`, `controls`, `preload="metadata"`.
- Use a child `<source src={url} type="video/mp4" />` so the browser gets a format hint.
- Add a guaranteed fallback below the player: an **"Open recording in new tab"** link and a **Download** link (an `<a href>` always works regardless of inline-playback quirks).

### 2. Always load a fresh recording URL + backfill transcript/summary (server)
Add an authenticated `refreshRecording({ id })` server function that, for a `done` meeting with a `recall_bot_id`:
- Re-pulls the bot from Recall and extracts a **fresh** signed recording URL, writes it back.
- If `transcript`/`summary` are still null, fetches the transcript and builds the summary now (reusing the existing Recall helpers), and links participants to contacts.
- Returns the fresh `recording_url` (and updated fields).

In the detail dialog, when a `done` meeting opens, call `refreshRecording` and use the returned fresh URL for the player (falling back to the stored one while it loads). This fixes expiry permanently and fills in the missing transcript/summary for the current meeting.

## Technical details

- `src/routes/_authenticated/meetings.tsx` (`MeetingDetail`): switch the `<video>` to `playsInline`/`preload="metadata"` with a `<source type="video/mp4">`; add Open/Download `<a>` links; add a `useServerFn(refreshRecording)` call in an effect that runs when a `done` meeting is opened, storing the returned URL in local state and invalidating `["meeting", id]` when transcript/summary come back. No change to the "Refresh status" button already added for non-terminal meetings.
- `src/lib/meetings.functions.ts`: add `refreshRecording` (`requireSupabaseAuth`, RLS-scoped ownership check, dynamic `import("./meetings.server")`). Add a small server helper in `src/lib/meetings.server.ts` (e.g. `refreshMeetingRecording`) that fetches the bot, extracts the recording URL, and backfills transcript/summary/contacts for an already-`done` row — mirroring the tail of `syncMeetingFromRecall` without regressing status.
- No database or schema changes; recording pipeline, webhook, and reconcile cron untouched.
