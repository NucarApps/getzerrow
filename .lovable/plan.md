# Fix: real replies getting filed into the "Invitations" folder

## What's happening

The "Invitations" folder is filled by the **AI classifier** (the description you pasted is its learned profile). The AI only sees the sender, subject, and body text. A genuine reply from someone you emailed — e.g. "Re: Invitation to the planning meeting" — reads to the AI exactly like an automated calendar invite, so it gets dropped into Invitations.

The thing that *actually* separates the two is never given to the AI:

- A **real automated calendar invite** carries an embedded calendar event (a `text/calendar` MIME part, usually an `.ics` "REQUEST"). Humans replying in a thread don't.
- A **human reply** is part of an existing conversation (it has an "in-reply-to" reference). Automated invites typically aren't replies.

We already capture the reply marker during parsing but don't pass it to the AI, and we don't detect the calendar-event marker at all.

## The fix

Give the classifier these two signals and teach it how to use them. This is a general improvement to classification (not hardcoded to "Invitations"), so it also helps any other automated-vs-human folder.

1. **Detect the calendar-event marker when parsing each email.** Add a `has_calendar_invite` flag computed by walking the message's MIME parts for a `text/calendar` part or an `.ics` attachment. (Transient — used only at classification time, no database change.)

2. **Pass both signals to the AI classifier.** Forward `is_reply` (already parsed) and the new `has_calendar_invite` flag into the classify call.

3. **Update the classifier instructions** so the model understands:
   - An email should only be treated as an automated calendar invite when it actually carries a calendar event.
   - A human reply in an existing thread should not be routed into an automated-invite folder, unless a folder explicitly targets replies.

4. **Refresh the "Invitations" learned profile wording** to mention that it applies to messages carrying an actual calendar event, not thread replies — reinforcing the new signal.

## Result

- Automated Google/Teams/Zoom calendar invites → still land in Invitations.
- Real replies from people you've emailed → stay in your inbox (or wherever their own rules send them), not Invitations.

You can keep correcting any stragglers with the existing "move to folder" action, which re-trains the folder.

## Technical details

- `src/lib/gmail.server.ts` (`parseMessage`): add a `has_calendar_invite` boolean by walking `payload.parts` for `mimeType` starting with `text/calendar`, or a filename ending in `.ics`.
- `src/lib/sync/classify.ts`: add `has_calendar_invite` to `ParsedEmailForClassify`; pass `is_reply` (derived from `in_reply_to`) and `has_calendar_invite` through `classifyByAi` → `classifyEmail`.
- `src/lib/ai.server.ts`: extend the `classifyEmail` (and the batch `classifyEmailsBatch`) email input + prompt to include the two flags and the guardrail wording above.
- No migration required (signals are computed and consumed in-flight).
- Add/extend a unit test in `src/lib/gmail-parse.test.ts` for `has_calendar_invite`, and verify classification logic compiles and existing sync tests pass.
