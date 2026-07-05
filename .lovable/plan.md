# Keep recordings alive when Screen Wake Lock isn't supported

## Problem

Both recorders in `src/routes/_authenticated/meetings.tsx` (mic-only in-person recorder and the desktop screen recorder) call a local `acquireWakeLock()` that does:

```text
if (!("wakeLock" in navigator)) return;   // silently gives up
```

On browsers without the Screen Wake Lock API (notably older iOS Safari, and some in-app/mobile webviews) nothing keeps the display on. The screen dims, the OS sleeps the device, the tab is suspended, and the `MediaRecorder` stops mid-recording — the exact "recording breaks on mobile" case.

## Fix

Add a battery-friendly fallback: when the native Wake Lock API is missing or its request fails, play a hidden, muted, looping, `playsInline` video (the well-established NoSleep.js technique). Playing a video keeps the screen awake on browsers that lack the API. Recording always starts from a button tap, so the play() call happens inside a user gesture and is allowed.

To avoid duplicating this in two places, extract the whole concern into one shared hook.

## Changes

### New file: `src/hooks/use-screen-wake-lock.ts`
A `useScreenWakeLock()` hook returning `{ acquire, release }`:

- `acquire()`:
  1. Try `navigator.wakeLock.request("screen")` when `"wakeLock" in navigator`. On success, store the sentinel.
  2. If unavailable or it throws, start the fallback: create (once) a detached `<video>` element that is `muted`, `loop`, `playsInline`, `webkit-playsinline`, off-screen, with a tiny inlined base64 video source, and `await video.play()`.
- `release()`: release the native sentinel (guarded `.catch`) and pause/reset the fallback video; null out refs.
- Re-acquire on `visibilitychange` when the document becomes visible again (browsers auto-release the native lock when the tab is hidden), so an app switch mid-recording doesn't permanently drop it.
- Clean up the listener and any fallback video on unmount.
- Strict TS, no `any`; type the sentinel as `WakeLockSentinel | null`.

### `src/routes/_authenticated/meetings.tsx`
- In the in-person (mic) recorder component: replace the local `wakeLockRef`, `acquireWakeLock`, `releaseWakeLock`, and the inline `visibilitychange` handler with the hook's `acquire`/`release`. Call `acquire()` where `void acquireWakeLock()` is today (after `recorder.start()`), and `release()` in `cleanupStream()`.
- In the screen recorder component: same swap — drop `wakeLockRef`/`acquireWakeLock`, call `acquire()` after the recorders start, and `release()` in `cleanup()` and `finishRecording()`.
- No change to recording, transcription, upload, or the desktop-only gating of the screen recorder.

## Technical notes

- The fallback video uses a very small inlined base64 clip (a fraction of a second, looped) so there is no network request and negligible memory; it is created lazily only when the native API is absent.
- The fallback is best-effort — if even `play()` is blocked, recording still proceeds exactly as it does today (no regression), it just may not hold the screen.
- Nothing here touches server functions, storage, or the DB.

## Out of scope
- Changing which audio sources are captured or how transcripts are produced.
- Mobile screen capture (still unsupported by mobile browsers).
