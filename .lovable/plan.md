# In-person meeting recording

Today every meeting is recorded by sending a bot to an online call link. This adds a second path: record an in-person conversation straight from the browser microphone, upload the audio, and run it through the same transcribe → summarize flow so it lands in the meetings list next to online ones.

## What the user gets

- A new "Record in person" button next to the existing "Record a meeting" button on the Meetings page.
- Clicking it opens a dialog that asks for microphone access and shows a live recording timer with a stop button (and an optional title field).
- On stop, the audio uploads, and the meeting appears in the list with a "Processing" badge that turns into "Done" once the transcript and summary are ready.
- Opening the meeting shows the same detail view: playable audio recording, transcript, and a key-moments summary.

## How it works

```text
Browser mic ──MediaRecorder──▶ audio blob
   │ upload (private bucket, {userId}/{meetingId}.webm)
   ▼
create meeting row (source=in_person, status=processing)
   │
   ▼ server fn: download audio ▶ Lovable AI transcribe ▶ summarize
   ▼
meeting updated (transcript, summary, status=done)
```

## Database (one migration)

- Add `in_person` to the `meeting_source` enum and `processing` to the `meeting_status` enum.
- Make `meetings.meeting_url` nullable (in-person meetings have no link).
- Add `meetings.audio_storage_path text` (null for bot meetings) to point at the uploaded file.
- No new table; RLS on `meetings` already scopes rows to the owner.

## Storage

- Create a private bucket `meeting-recordings`.
- RLS policies on `storage.objects` so an authenticated user can insert/select/delete only under their own `{userId}/` prefix.
- The browser client uploads the recorded blob directly (same pattern already used for bot avatars).

## Server functions (`src/lib/meetings.functions.ts`)

- `createInPersonMeeting` (POST, auth): inserts a meeting row with `source=in_person`, `platform=in_person`, `status=processing`, `audio_storage_path`, optional title; returns the new id so the client can upload to a deterministic path.
- `transcribeInPersonMeeting` (POST, auth): verifies ownership, then delegates to a server-only helper that downloads the audio, transcribes it, generates the summary, and flips status to `done` (or `failed` with an error message).
- Extend `getRecordingStreamUrl`: when a meeting has `audio_storage_path`, return a fresh signed Storage URL (valid ~2h) for the `<audio>`/`<video>` element instead of the Recall streaming path. Bot meetings keep their current behavior.

## Transcription + summary (`src/lib/meetings.server.ts`)

- New `finalizeInPersonMeeting(meetingId)`:
  - Downloads the audio from the bucket with the service-role client.
  - Sends it to the Lovable AI Gateway speech-to-text endpoint (`openai/gpt-4o-mini-transcribe`, multipart form) to get transcript text.
  - Generates a "Key moments" summary from the transcript with the default chat model (`google/gemini-3-flash-preview`), matching the existing summary style.
  - Writes `transcript`, `summary`, `ended_at`, and `status=done`; on any failure sets `status=failed` with a friendly error.

## UI

- `src/routes/_authenticated/meetings.tsx`: add an `InPersonRecordDialog` component (mic capture via `MediaRecorder`, elapsed-timer, stop, upload, then call the transcribe function). Add its trigger button in the header next to the current record dialog.
- Add `processing` to the status label/style maps and treat it as non-terminal so the list keeps polling until it flips to done.
- The existing meeting detail sheet already renders recording + transcript + summary, so no changes are needed there beyond the audio source coming from the extended `getRecordingStreamUrl`.

## Technical notes

- Recording is audio-only at a modest bitrate to keep files small; MediaRecorder outputs `audio/webm` on Chrome/Firefox and `audio/mp4` on Safari, both accepted by the transcription endpoint. Very long meetings could approach the endpoint's file-size limit — MVP transcribes the whole file in one call; chunking can be added later if needed.
- All AI and storage-admin work stays server-side; the browser only uploads the blob and calls the auth-scoped server functions. `LOVABLE_API_KEY` and `MEETING_STREAM_SECRET` already exist.
