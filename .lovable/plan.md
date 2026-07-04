## Plan

1. **Make the recording state explicit**
   - Show a clear message when a meeting is marked done but there is no playable recording URL.
   - Show whether Zerrow found transcript/summary content so you can tell if anything was captured.

2. **Improve playback fallback**
   - Keep the inline video player, but add a visible fallback when the browser cannot load/play it.
   - Add a primary “Open recording” action so the raw recording can be tested outside the embedded preview.

3. **Expose refresh errors instead of silently ignoring them**
   - If refreshing the signed recording URL fails, show a friendly error in the meeting dialog.
   - Add a manual “Refresh recording” action for completed meetings.

4. **Backend refresh hardening**
   - During refresh, verify whether Recall actually reports a video recording and transcript.
   - Return lightweight recording diagnostics to the UI: has recording URL, has transcript, has summary.

## Technical notes

- Files to change: `src/routes/_authenticated/meetings.tsx`, `src/lib/meetings.functions.ts`, `src/lib/meetings.server.ts`.
- No database schema changes.
- No changes to the recording start flow unless diagnostics show Recall never produced media.