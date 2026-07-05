## Goal

Make in-person recordings play inline in the browser (including on iPhone), instead of showing the native "Error" bar or a download-only fallback.

## Root cause (verified against the real file)

The one existing in-person recording ("Test") is stored as a **fragmented MP4** — the container `MediaRecorder` emits on iOS Safari (box order `ftyp → moov → moof → mdat`). Safari's `<audio>` element cannot play fragmented MP4 inline, so it renders "Error". The audio data is valid (AAC, mono, ~99s); remuxing to a **progressive** MP4 with faststart (`moov` before `mdat`, no `moof`) makes it play. Verified locally with ffmpeg.

New recordings are already captured as WAV by the current recorder, which plays inline — so only legacy fragmented-MP4 files are broken.

## Changes

### 1. Repair existing legacy recordings (one-time data migration, sandbox)
- Query in-person meetings and, for each `audio_storage_path`, download the object (service-role signed URL).
- Detect a fragmented MP4 (presence of a `moof` box). For those, run `ffmpeg -i in -c copy -movflags +faststart` to produce a progressive file (lossless, keeps AAC).
- Re-upload to the **same** storage path with `upsert: true`, content type `audio/mp4`.
- Leave already-progressive files and WAV files untouched.
- This immediately fixes the "Test" recording so it plays inline.

### 2. UI: inline playback is primary for in-person audio
`src/routes/_authenticated/meetings.tsx` (the `streamUrl` block):
- Revert the "swap to a download-only card on error" behavior added last turn. Always render the `<audio>` player for audio recordings so playback is the primary experience.
- Keep Open recording / Download only as a secondary link beneath the player (in the existing collapsible), not as a replacement for it.
- This means a working recording just plays; download is available but never takes over the UI.

### 3. Future-proofing (no code change needed, confirmed)
The in-person recorder already encodes 16 kHz mono PCM WAV (`encodeWav`) and uploads with `audio/wav`, which plays inline everywhere — so no new fragmented-MP4 files will be created. No change required here; noted for completeness.

## Verification

- After the migration, re-download the "Test" object and confirm box order is `ftyp → moov → … → mdat` with no `moof`.
- Typecheck with `tsgo --noEmit`.
- In the preview, open the "Test" in-person meeting and confirm the audio player shows real controls and plays (no "Error" bar, no download-only card).

## Technical notes

- ffmpeg is available in the build sandbox (used for the one-time remux) but NOT in the Cloudflare Worker runtime, so remux cannot run per-request in production. That's why the fix repairs stored files once and relies on WAV capture going forward, rather than transcoding on the fly.
- Progressive AAC MP4 and WAV both play inline via the existing Supabase signed URL (correct content type + Range support), so no streaming proxy is needed for in-person audio.