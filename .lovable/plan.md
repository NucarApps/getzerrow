## Problem

When recording a meeting, the link field only accepts a bare URL (e.g. `https://meet.google.com/abc-defg-hij`). You pasted the whole calendar invite text ("Chris Dagesse has invited you to join a video meeting…"), which isn't a bare URL, so:

1. Validation rejected it as an "Unsupported meeting link".
2. The raw validation error (the big JSON blob in your screenshot) was shown instead of a plain-English message.

## Fix

Make the link field forgiving: pull the real Zoom/Meet/Teams/Webex URL out of whatever text is pasted, and surface clean error messages.

### 1. Extract the URL from pasted text
Add a small helper that scans any pasted string for the first supported meeting URL (Zoom, Google Meet, Teams, Webex) and returns just that link. Invite emails and calendar blurbs almost always contain the actual join URL somewhere in the text — this grabs it automatically.

- Used on the client the moment text is entered/pasted, so the field self-corrects to the clean link.
- Also applied server-side in `recordFromLink` before validation, as a safety net.

### 2. Friendly, specific errors
- If no supported link can be found in the pasted text, show: "We couldn't find a supported meeting link. Paste a Zoom, Google Meet, or Microsoft Teams link." — instead of the raw validation JSON.
- Keep the existing "Could not start the recording bot…" message for real bot failures.

### 3. Small UX touches on the Record dialog
- Show a subtle inline hint under the field once a link is detected ("Detected Google Meet link ✓") so it's clear the paste worked.
- Trim/normalize the value before sending.

## Technical details

- `src/lib/meetings.functions.ts`: add an `extractMeetingUrl(text)` helper (shared, pure regex over the existing `MEETING_URL_RE` pattern, made global to search anywhere in the string). In `recordFromLink`, run the raw input through it before Zod validation; on validation failure throw a clean message rather than letting the Zod error propagate.
- `src/routes/_authenticated/meetings.tsx` (`RecordDialog`): run the input through the same extractor on change, store the cleaned URL, show the detected-platform hint, and map failures to the friendly toast text. Disable "Send notetaker" until a valid link is detected.
- No database or schema changes; recording/transcription pipeline is untouched.
