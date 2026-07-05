## Goal

Make the in-person meeting recorder tell the user exactly why the microphone failed and how to fix it, instead of always showing "Microphone access was blocked." The recorder currently catches every error into a single generic message with no recovery guidance, which is why a browser-level block (no prompt on an HTTPS site) looks like an unexplained dead end.

This is a frontend-only change in `src/routes/_authenticated/meetings.tsx`. No backend, storage, or transcription logic changes.

## Root cause

On the published HTTPS site with "no prompt appears", the browser has already denied microphone access for the site (permission is persisted as "Block"), so `getUserMedia` rejects immediately without prompting. The code's single `catch` maps everything to "Microphone access was blocked. Allow it and try again.", giving no way to tell this apart from a missing mic, a mic in use, or an unsupported browser — and no steps to re-enable it.

## Changes (in `RecordDialog` / `startRecording`)

1. **Pre-flight capability check**: before calling `getUserMedia`, verify `window.isSecureContext` and `navigator.mediaDevices?.getUserMedia` exist. If not, show "Recording needs a secure (https) connection in a supported browser." This avoids a confusing generic failure when the API is unavailable.

2. **Proactive permission read**: if `navigator.permissions?.query({ name: "microphone" })` is available, check the state first. When it is `"denied"`, show the blocked-guidance message immediately (see step 4) without even calling `getUserMedia`. Wrapped in try/catch since Safari doesn't support the query.

3. **Preserve the user-gesture chain**: keep `getUserMedia` as the first `await` inside the click handler (it already is) so no browser drops the request for lack of a gesture.

4. **Precise error mapping** by `err.name`:
   - `NotAllowedError` / `SecurityError` → "Microphone is blocked for this site. Click the padlock (or camera/mic icon) in your browser's address bar, set Microphone to Allow, then reload and try again."
   - `NotFoundError` / `OverconstrainedError` → "No microphone was found. Connect a mic and try again."
   - `NotReadableError` / `AbortError` → "Your microphone is in use by another app. Close it and try again."
   - anything else → keep a clear generic fallback with the error name.

5. **Recovery affordance**: when the error is a block/denied state, render a small helper line under the error with a "Reload page" button (calls `window.location.reload()`), since re-granting a blocked permission requires a reload after the user flips the browser setting.

6. **Clear stale error on reopen/retry**: reset the error each time the dialog opens and each time Start recording is pressed (already partly done) so guidance doesn't linger after a fix.

## Technical notes

- All copy uses sentence case and friendly tone per project conventions.
- No new dependencies; uses existing `navigator` APIs, shadcn `Button`, and current state (`error`, `setError`).
- After the change I'll verify the build, then drive the published-style flow to confirm the specific messages render for the denied path (simulated by overriding `getUserMedia` to reject with a `NotAllowedError` in a Playwright check).
- Because this is browser-permission behavior, the real end fix on the user's side is flipping the site's mic setting to Allow and reloading; the UI will now spell that out.

## Out of scope

- Switching to Web Audio + WAV capture (only needed if we later see format/decoding failures during transcription; current issue is permission, not encoding).
- Any change to upload, `createInPersonMeeting`, or `transcribeInPersonMeeting`.