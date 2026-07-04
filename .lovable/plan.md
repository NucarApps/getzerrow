# Make the embedded meeting player actually play

## What's wrong

The recording streaming proxy (`/api/public/meeting-recording`) calls the heavy
`refreshMeetingRecording()` on **every** HTTP request. A `<video>` element
issues many parallel byte-range requests while playing/seeking, and each one
currently triggers:

- a Recall `getBot` API call, plus
- (whenever `transcript` or `summary` is null — which is the case for real
  meetings) a Recall `getTranscript` call + summarize + database writes +
  participant→contact linking.

Under the browser's concurrent range requests this overwhelms the hot path
(slow responses, Recall rate limits). Any failed range request returns 404
mid-stream, so the player renders but stalls and never plays. A single `curl`
succeeds because it's one request; a browser is not.

Verified facts:
- The proxy already returns correct `video/mp4`, `200/206`, and honors `Range`.
- The stored file is a valid faststart H.264/AAC MP4 — fully playable.
- The affected meeting has a valid `recording_url` but `transcript`/`summary`
  are `NULL`, so the per-request transcript backfill runs every time.

## Fix: keep the streaming hot path cheap and self-healing

Change the proxy so it never does transcript/summary work and only touches
Recall when strictly necessary.

1. **Add a lightweight resolver** in `src/lib/meetings.server.ts`, e.g.
   `resolvePlayableRecordingUrl(meetingId)`:
   - Read the meeting's stored `recording_url` (service-role select only).
   - Return it directly. No `getTranscript`, no summarize, no DB writes, no
     participant linking.
   - Only if there is no stored URL, call `getBot` + `extractRecordingUrl`
     once, persist the fresh URL, and return it.

2. **Rework the proxy** (`src/routes/api/public/meeting-recording.ts`):
   - Verify the token (unchanged).
   - Get the URL from `resolvePlayableRecordingUrl`.
   - Fetch it with the forwarded `Range` header.
   - If that upstream fetch fails with an auth/expiry error (e.g. 403), fall
     back **once** to `getBot` + `extractRecordingUrl` to mint a fresh signed
     S3 URL, persist it, and retry the fetch. This makes expired-link recovery
     automatic without doing it on every request.
   - Keep the existing `video/mp4` rewrite, `Accept-Ranges`, `Content-Range`,
     `Content-Length`, and download-disposition handling.

3. **Keep transcript/summary backfill off the streaming path.** It stays where
   it belongs — in `refreshRecording` / `getRecordingStreamUrl`, which run once
   when the meeting dialog opens (and via the "Refresh recording" button), not
   per byte-range.

## Not changing

- The calendar-exclusion settings section is already implemented and working
  (`MeetingCalendarEventsCard`, `meeting_autojoin_exclusions` table,
  `listUpcomingCalendarEvents` / `setEventExclusion`, and auto-record skipping
  excluded events). No work needed there.
- Token signing/verification, the `<video>` UI, and Open/Download links stay as
  they are.

## Verification

- Re-run the direct proxy `curl` (200 + `206` on Range) to confirm no
  regression.
- Load a finished meeting in the preview and confirm the video plays and seeks
  without stalling, and that the "Refresh recording" button still backfills
  transcript/summary.

## Technical notes

- Files touched: `src/lib/meetings.server.ts` (new cheap resolver + one-shot
  refresh-on-403 helper) and `src/routes/api/public/meeting-recording.ts`
  (use the resolver, add single retry). No schema changes, no new secrets.
- `refreshMeetingRecording` remains for the dialog/refresh flow; only the proxy
  stops using it.
