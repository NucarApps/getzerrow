## Goal

Make in-person meeting recordings play back reliably as **audio only**, instead of failing with "The embedded player could not load this recording." This is a frontend + playback-path change in the meetings detail view and its stream resolver. No changes to recording capture, transcription, or summaries.

## Root cause

In-person recordings are saved as an audio-only file (`audio/mp4`) in the app's storage bucket — they have no video track and no Recall bot. The playback code decides between an `<audio>` element and a `<video>` element based on a `kind` returned by `getRecordingStreamUrl`. When a recording resolves to the Recall video proxy path (`/api/public/meeting-recording`), that route tries to fetch a Recall recording; for an in-person meeting there is nothing to resolve, so it 404s and the `<video>` element fires its error handler — producing the message the user saw. The confirmed record has a valid, transcribed `audio/mp4` file, so the file itself is fine; only the playback routing is wrong.

## Changes

1. **Guarantee in-person → audio player** (`src/lib/meetings.functions.ts`, `getRecordingStreamUrl`): keep returning `kind: "audio"` with a direct signed storage URL whenever `audio_storage_path` is set, and make this the first branch so an in-person recording can never fall through to the Recall video proxy. (Already the intended behavior — this hardens and confirms it.)

2. **Render audio-only recordings in an `<audio>` element** (`src/routes/_authenticated/meetings.tsx`): when `streamKind === "audio"`, show the audio player (no `<video>`), which is the existing branch — verify it is correct and that `streamKind` is initialized/reset so a stale `"video"` value can't be used on first render.

3. **Clearer, kind-aware fallback copy + actions**: when inline playback still fails on a given browser, show audio-appropriate guidance ("This recording is audio only. If it doesn't play here, use Open recording or Download to listen.") and keep the **Open recording** and **Download** buttons pointing at the direct signed audio URL, which work even when inline playback is blocked. Label the section for audio ("Recording (audio)") so it's obvious in-person meetings have no video.

4. **Ship it**: the live site (getzerrow.com) is running an older build that predates the audio branch, which is why the error appears there. After the change is verified, publish so the fix reaches the live site.

## Technical notes

- Sentence-case, friendly copy per project conventions.
- No new dependencies; uses the existing signed-storage-URL flow (`meeting-recordings` bucket, 2h TTL) and shadcn components.
- No server-side transcoding is added (the Worker runtime has no ffmpeg); the direct `audio/mp4` signed URL supports Range requests and the correct `audio/mp4` content type, so a native `<audio>` element plays it inline in Chrome/Android and modern iOS Safari, with Open/Download as guaranteed fallbacks.

## Verification

- Confirm the type-check passes.
- Open the existing "Test" in-person meeting and confirm an audio player renders (not a video element) and no error banner shows.
- Confirm **Open recording** and **Download** resolve to the signed `audio/mp4` URL.

## Out of scope

- Recording capture format, transcription, and summary generation (all confirmed working).
- Recall/video-meeting playback (unchanged).
