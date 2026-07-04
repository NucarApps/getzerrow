# Fix meeting playback + add per-event notetaker control

## Part 1 — Make the embedded player actually work

### Root cause (confirmed)
Recall stores recordings in S3 and serves the file with `Content-Type: binary/octet-stream`. I verified this against your latest meeting's file:

```text
Content-Type: binary/octet-stream
Accept-Ranges: bytes
Content-Range: bytes 0-100/6410520
```

The bytes and range requests are fine, but mobile Safari (and some desktop browsers) refuse to play a `<video>` whose response says `binary/octet-stream`, even with a `<source type="video/mp4">` hint. That is exactly the "embedded player could not load this recording" state in your screenshot.

The stored URL is also a short-lived signed S3 URL that expires, so a `<video>` element can't carry an auth header anyway.

### Fix: a same-origin streaming proxy that corrects the content type
1. **New authenticated server function `getRecordingStreamUrl({ id })`** (in `src/lib/meetings.functions.ts`): verifies the caller owns the meeting, then mints a short-lived signed token (HMAC of `meetingId + expiry`) and returns a same-origin URL like `/api/public/meeting-recording?m={id}&t={token}&e={exp}`. The `<video>` element needs no auth header — the signed token is the credential.
2. **New public server route `src/routes/api/public/meeting-recording.ts` (GET)**: validates the HMAC token + expiry, loads the meeting with the admin client, fetches a *fresh* signed recording URL from Recall server-side, then fetches the S3 object forwarding the browser's `Range` header and streams the body back with corrected headers: `Content-Type: video/mp4`, `Accept-Ranges: bytes`, passed-through `Content-Range`/`Content-Length`, and status `200`/`206`. A `dl=1` variant sets `Content-Disposition: attachment` for the download button.
3. **New signing secret** `MEETING_STREAM_SECRET` (auto-generated) used only to sign/verify the stream token.
4. **`src/routes/_authenticated/meetings.tsx`**: point the `<video>` `src` and the "Open recording"/"Download" links at the proxy URL instead of the raw S3 URL. Keep the existing "Refresh recording" fallback and error message. Because the proxy always returns `video/mp4` from a freshly-signed source, inline playback works on mobile and desktop and the URL never serves an expired link.

## Part 2 — Calendar events list with per-event notetaker control

Today auto-record is all-or-nothing per inbox: when it's on, the cron tick sends a bot to every upcoming calendar event that has a Zoom/Meet/Teams link. There's no way to say "skip this one."

### Changes
1. **New table `meeting_autojoin_exclusions`** (`id`, `user_id`, `gmail_account_id`, `calendar_event_id`, `created_at`) with RLS scoped to `auth.uid()` and the required GRANTs. A row means "do not send the notetaker to this event."
2. **New server function `listUpcomingCalendarEvents({ accountId })`**: fetches the account's upcoming primary-calendar events (next ~14 days), returns per event: title, start time, whether it has a supported meeting link, whether a bot is already scheduled (from `meetings.calendar_event_id`), and whether it's currently excluded.
3. **New server function `setEventExclusion({ accountId, calendarEventId, excluded })`**: inserts/deletes an exclusion row (ownership-checked).
4. **Update `scheduleUpcomingMeetingBots`** (`src/lib/meetings-autojoin.server.ts`): skip any event whose id is in `meeting_autojoin_exclusions` for that user, alongside the existing "already scheduled" dedupe.
5. **New settings component `MeetingCalendarEventsCard`**: lists upcoming events for each calendar-enabled inbox with a per-event "Send notetaker" toggle (on by default; toggling off records an exclusion). Events without a supported meeting link are shown as non-recordable/greyed. Rendered in `src/routes/_authenticated/settings.tsx` right under the existing Auto-record card. Only meaningful when auto-record is on for that inbox, so it notes that.

## Notes / scope
- No changes to the recording start flow, transcript, or summary logic beyond reusing the existing fresh-URL refresh.
- One migration (the exclusions table). No changes to auth or existing tables.
- Copy stays sentence case and friendly, matching the rest of settings.

## Technical details
- Streaming through the Cloudflare Worker uses `fetch(freshS3Url, { headers: { Range } })` and returns `new Response(res.body, { status, headers })` — body streaming with range passthrough is supported on the runtime.
- The stream token is verified with `crypto` HMAC + a constant-time compare and an expiry check; the `/api/public/*` route does its own auth via that token (never the publishable key), consistent with the project's public-endpoint rule.
- `getRecordingStreamUrl` and `setEventExclusion`/`listUpcomingCalendarEvents` use `requireSupabaseAuth`; they're called from components/`useServerFn`, not from public-route loaders.
