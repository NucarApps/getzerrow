# Fix meeting transcript & summary (Recall API change)

## What's wrong

For bot-recorded meetings, the transcript and summary never populate — meetings finish with status **Done** but empty transcript/summary.

Root cause: the bot is created with Recall's current API (`recording_config` + a transcript that lands as a downloadable file), but `getTranscript()` still calls the **legacy** endpoint `GET /bot/{id}/transcript`. Recall now rejects that endpoint with HTTP 400 ("This is a legacy endpoint…"). Because the code only swallows 404s, the call throws, the transcript step is skipped, and the meeting is saved Done with nothing attached. Verified live against the affected bot: the legacy endpoint returns 400, while the bot's `recordings[0].media_shortcuts.transcript.data.download_url` returns a ready transcript JSON.

## The fix

All changes are server-side; no schema or UI changes.

### `src/lib/recall.server.ts`
- Rewrite `getTranscript` to read from the recording's transcript file instead of the legacy endpoint:
  - Accept the already-fetched `RecallBot` object (callers already have it) instead of a bot id.
  - Read `bot.recordings[0].media_shortcuts.transcript.data.download_url`. If absent (transcript not ready yet), return `[]` — the existing refresh/poll path will backfill later.
  - `fetch` that signed S3 URL (no auth header; add a timeout), parse the JSON array, and map each entry to our `TranscriptSegment`:
    - `speaker` ← `entry.participant?.name ?? null`
    - `text` ← the entry's `words[].text` joined and whitespace-collapsed
    - `start` ← first word's `start_timestamp.relative`
  - Filter out empty-text segments (unchanged behavior).
- Update the transcript entry type to the current shape (`participant.name`, `words[].text`, `words[].start_timestamp.relative`).

### `src/lib/meetings.server.ts`
- Update the two callers to pass the bot object: `getTranscript(bot)` in `syncMeetingFromRecall` and in `refreshMeetingRecording` (both already have `bot` in scope).

The summary is derived from the transcript (`summarizeTranscript`), so once the transcript is read correctly the summary populates automatically.

## Backfilling the existing meeting

The one already-finished meeting will fill in its transcript/summary the next time it's refreshed — opening it and using **Refresh recording**, or the next reconcile — since `refreshMeetingRecording` backfills transcript/summary when they're missing.

## Verification

After the change, run a real bot recording (or refresh the existing meeting) and confirm the transcript and summary appear, and that the transcript file fetch path works against a live Recall bot.

## Note on in-person meetings

In-person recordings use a different path (browser mic → Lovable AI transcription) and are unaffected by this bug; their transcript depends on the uploaded audio actually containing audible speech.
