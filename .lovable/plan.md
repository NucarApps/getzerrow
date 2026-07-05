# Keep mobile mic recording going when the screen would turn off

## Problem
On mobile, when you start an in-person recording and the phone screen turns off (locks/sleeps), the browser suspends the tab and the `MediaRecorder` stops — so you lose the rest of the conversation.

## Fix
Hold a **Screen Wake Lock** while a recording is active. This keeps the screen from turning off during capture, so the mic keeps recording until you tap Stop. The lock is released the moment recording stops, so it never keeps the screen on longer than needed and doesn't affect battery outside of recording.

Scope: only the in-person mic recorder (`InPersonRecordDialog`) records on the device, so this is the only place that needs it. Nothing changes for the bot-based "Record" flow.

## Behavior
- Tap **Start recording** → screen stays awake for the whole recording.
- Tap **Stop & save** (or recording ends/errors) → wake lock released, screen can sleep normally again.
- If you switch apps and come back mid-recording, the lock is re-acquired automatically.
- On browsers/devices without wake lock support (e.g. some iOS versions), recording works exactly as today — no error, it just can't force the screen to stay on.

## Technical details
In `src/routes/_authenticated/meetings.tsx`, inside `InPersonRecordDialog`:

1. Add a `wakeLockRef` (`WakeLockSentinel | null`) and two helpers:
   - `acquireWakeLock()` — feature-detect `navigator.wakeLock`, call `navigator.wakeLock.request("screen")`, store the sentinel; wrap in try/catch and no-op on failure.
   - `releaseWakeLock()` — release the sentinel if present and clear the ref.
2. Call `acquireWakeLock()` right after `recorder.start()` succeeds (in `startRecording`).
3. Call `releaseWakeLock()` in `cleanupStream()` so it's released on stop, finish, error, and reset — every teardown path already funnels through there.
4. Re-acquire on resume: add a `visibilitychange` listener (active only while `phase === "recording"`) that re-requests the lock when the document becomes visible again, since the browser auto-releases wake locks when the tab is hidden. Clean up the listener on teardown.
5. Type note: add a minimal `WakeLockSentinel` type reference (or `unknown` narrowed) to satisfy strict TypeScript without `any`.

No backend, schema, or business-logic changes — this is entirely client-side capture reliability.
