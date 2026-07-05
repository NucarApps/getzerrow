# Desktop screen recording (audio-only on mobile)

## Goal
- **Mobile:** unchanged — only the mic "Record in person" (audio) option is available.
- **Desktop:** add a second option, **Record screen**, that captures the screen with **system/tab audio + your mic**, saves a **playable video**, and produces a transcript + summary from the mixed audio.

## Behavior
- On desktop the Meetings header shows a new **Record screen** button next to the existing audio and bot-record buttons. On mobile that button is hidden (screen capture isn't supported by mobile browsers anyway).
- Clicking it prompts the browser's "choose what to share" picker (tab/window/screen) and asks for mic access, then records. A live timer shows while recording.
- Stopping (via the in-app Stop button or the browser's "Stop sharing" bar) uploads the video, then transcribes and summarizes automatically — same flow as the audio recorder.
- The meeting detail view plays the recording back as **video**, with the transcript and summary below it.
- If screen capture or mic is blocked/cancelled, a clear message is shown and nothing is saved.

## How capture works (technical)
Screen + video can't be transcribed reliably by sending a video container to the speech model, so the client records **two files at once** from the same session:
1. A **video** file (screen video + mixed audio) for playback.
2. An **audio-only** file (mixed audio) for transcription.

Audio mixing: capture `getDisplayMedia({ video: true, audio: true })` for system/tab audio and `getUserMedia({ audio: true })` for the mic, then combine both into one track via a Web Audio `AudioContext` + `MediaStreamAudioDestinationNode`. One `MediaRecorder` records `[displayVideoTrack, mixedAudioTrack]` → video webm; a second records the mixed audio (cloned track) → audio webm. Listen for the display track's `ended` event so the browser "Stop sharing" control also ends the recording. The existing screen-wake-lock helper is reused.

## Files & changes

### Database (migration)
- Add `video_storage_path text null` to `public.meetings`. No new grants/policies needed — existing table grants and RLS (scoped to `auth.uid()`) already cover it; the storage bucket `meeting-recordings` already accepts uploads under the user's `{userId}/…` prefix.

### `src/lib/meetings.functions.ts`
- `createInPersonMeeting`: accept an optional `withVideo: boolean` (and a `videoExt`); when set, also return a `videoPath` (`{userId}/{id}.video.webm`) alongside `audioPath`.
- `transcribeInPersonMeeting`: accept optional `videoPath`; when present, save it to `video_storage_path` (transcription still runs off `audioPath`).
- `getRecordingStreamUrl`: add a **video branch before** the audio branch — if `video_storage_path` is set, sign it from the bucket and return `kind: "video"`; otherwise keep the existing audio branch. (Select `video_storage_path` in the query.)
- `refreshRecording`: treat `video_storage_path` as `hasRecording` too.

### `src/routes/_authenticated/meetings.tsx`
- Add a `ScreenRecordDialog` component (modeled on `InPersonRecordDialog`) implementing the dual-recorder capture above, uploading both blobs to `meeting-recordings`, then calling `transcribeInPersonMeeting` with both paths. Uses a `Monitor` icon, label "Record screen".
- In the header, render `ScreenRecordDialog` only when `!useIsMobile()` (import the existing `useIsMobile` hook). The audio and bot buttons stay as-is.
- Detail view already renders `kind: "video"` in a `<video>` element, so playback needs no change beyond what already exists; label the section "Recording".

### `src/integrations/supabase/types.ts`
- Regenerated to include the new `video_storage_path` column (happens with the migration).

## Out of scope
- Mobile screen capture (not supported by mobile browsers).
- Changes to the Recall bot flow or the existing audio recorder's behavior.
