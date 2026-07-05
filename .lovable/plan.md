# Fix looping/repeating in-person transcripts (iOS audio)

## Root cause

The in-person recorder (`InPersonRecordDialog` in `src/routes/_authenticated/meetings.tsx`) captures audio with `new MediaRecorder(stream)` and no explicit format. On iPhone/iOS Safari that produces a **fragmented MP4/AAC** file. Two things break because of it:

1. The browser `<audio>` element often can't decode it → the player shows **Error** ("audio only… doesn't play here").
2. The speech-to-text model (`openai/gpt-4o-mini-transcribe` in `finalizeInPersonMeeting`) can't cleanly decode it either, so it **hallucinates and loops**, repeating the same phrase over and over — exactly what's on screen.

The transcript is saved as one segment and rendered once, so this is not a UI duplication bug; the repeated text is in the model output.

The reliable fix (per the speech-to-text guidance) is to stop relying on the browser's opaque recorder container and instead capture raw PCM and upload a standard **WAV** file, which every browser and the STT model can decode.

## Changes

### 1. New util `src/lib/wav-encoder.ts`
Pure function `encodeWav(chunks: Float32Array[], sampleRate: number): Blob`:
- Concatenate PCM chunks, downsample to 16 kHz mono, write a standard 16-bit PCM WAV header + samples, return a `Blob` typed `audio/wav`.
- No DOM/Supabase imports so it stays unit-testable.

### 2. New util test `src/lib/wav-encoder.test.ts`
- Verifies a valid `RIFF/WAVE` header, correct sample-rate/channel bytes, and that sample count matches the downsampled input.

### 3. `src/routes/_authenticated/meetings.tsx` — in-person recorder only
Replace the `MediaRecorder` capture with Web Audio PCM capture:
- Keep the existing secure-context / permission checks and the `useScreenWakeLock` acquire/release wiring.
- On start: `getUserMedia({ audio: true })` → `AudioContext` → `createMediaStreamSource` → `ScriptProcessorNode(4096,1,1)`; push `Float32Array` copies of each frame into a ref. (ScriptProcessorNode is used deliberately for iOS Safari compatibility, as in the STT guidance.)
- On stop: stop tracks, disconnect nodes, `encodeWav(pcm, ctx.sampleRate)`, `await ctx.close()`.
- Reject near-empty recordings with a byte floor (`blob.size < 2048`) → show "That recording was empty — please try again." instead of uploading.
- Upload with `contentType: "audio/wav"` and call `createInPersonMeeting({ ext: "wav" })` (the validator and `audioMimeFor` already support `wav`), then `transcribeInPersonMeeting` as today.
- Update the recorder refs/cleanup to the new nodes (source/processor/AudioContext) and drop the `MediaRecorder`/`chunksRef` for this dialog.

The desktop screen recorder is unchanged — it runs in Chrome and produces WebM/Opus, which decodes fine.

### 4. `src/lib/meetings.server.ts` — defensive de-loop safeguard
In `finalizeInPersonMeeting`, after getting `transcriptText`, add a small guard that collapses pathological immediate repetition (e.g. the same sentence/phrase repeated back-to-back many times) down to a single occurrence before saving. This is a cheap safety net so a future bad clip can't produce a wall of duplicated text even if the model still loops. It only collapses exact consecutive repeats; normal transcripts are untouched.

## Verification
- Run the new WAV encoder unit test.
- Typecheck the changed files.
- Sanity-check in the preview that starting/stopping an in-person recording uploads a `.wav`, the player plays it back, and the transcript renders once without repetition.

## Out of scope
- The Recall bot meeting flow and the desktop screen-recorder flow.
- Changing the STT model or summary generation.
