# Block recording meetings that include a blocked person

## Goal
Extend the existing "don't auto-record" list so it doesn't just skip *automatic* calendar recordings — it also refuses a **manual** "record from link" when the meeting includes someone on your list. Today the check only runs in the auto-record scheduler; a person could still paste a link and record a blocked attendee.

## How it will work
- **Manual record from link:** when you paste a meeting link, before sending the notetaker the app looks up your calendar for the matching event, reads its attendees/organizer, and if any of them are on your blocklist (by email or by domain), it refuses with a clear message like "Not recorded — jane@lawfirm.com is on your don't-record list." No bot is sent, no recording starts.
- **Auto-record (calendar):** unchanged — already skips these meetings.
- **Safety net after the bot joins:** if a blocked person's email shows up in the meeting's participant data once the bot is in the call, the app pulls the bot out and marks the meeting stopped instead of saving the recording.

## Important limitation (surfaced honestly)
Reliable blocking depends on knowing attendee **email addresses**, which come from your Google Calendar. If you paste a link for a meeting that isn't on your calendar, the app can't know who's invited until the bot joins — and meeting platforms (Zoom/Meet/Teams) usually only report participants' display names, not emails. So the pre-join block is guaranteed only for meetings on your calendar; for ad-hoc links the safety net is best-effort. This matches how the auto-record blocklist already behaves.

---

## Technical details

### 1. Reuse the blocklist match logic
`src/lib/meetings-autojoin.server.ts` already has `loadBlocklist(userId)` and `hasBlockedAttendee(emails, blocklist)` plus `findBlockedAttendee` semantics. Export these (and add a variant that returns *which* entry matched, so the error message can name it) so other server code can reuse them without duplicating logic.

### 2. New server-only helper: match a link to calendar attendees
Add `findBlockedAttendeeForMeetingUrl(userId, meetingUrl)` to `meetings-autojoin.server.ts` (server-only, uses `supabaseAdmin` + `getAccessToken`):
- Load the user's blocklist; if empty, return `null` fast.
- For each of the user's calendar-access gmail accounts, fetch events in a window around now (e.g. next 24h + recently started), reuse `extractMeetingUrl`, and find an event whose meeting URL matches the pasted link (normalized comparison — strip query/hash, lowercase host).
- Collect attendee + organizer emails from the matched event and return the first blocked email/domain (or `null`).

### 3. Enforce in manual record path
In `recordFromLink` (`src/lib/meetings.functions.ts`), inside `.handler`, before `createBot`:
- `const blocked = await (await import("./meetings-autojoin.server")).findBlockedAttendeeForMeetingUrl(userId, data.meetingUrl)`.
- If `blocked`, throw `new Error(\`Not recorded — ${blocked} is on your don't-record list.\`)` so the existing toast surfaces it. No bot, no meeting row.

### 4. Safety net in the Recall webhook / sync
- Extend the `RecallBot` type in `src/lib/recall.server.ts` to include the participant list Recall returns (e.g. `meeting_participants: Array<{ name?: string; email?: string | null }>`), and add a small `extractParticipantEmails(bot)` helper.
- In `syncMeetingFromRecall` (`src/lib/meetings.server.ts`), when status becomes `recording` or `done`, load the meeting owner's blocklist and check participant emails. If a blocked email is present: call `leaveBot(recall_bot_id)`, set the meeting `status = "failed"` with `error = "Recording stopped — a blocked person was in the meeting."`, and skip storing `recording_url`/`transcript`/`summary`. (Uses the existing `failed` enum value — no schema change.)

### 5. No UI changes required
The existing "Don't auto-record these people" card in Settings → Meetings is the single source of the list. Optionally update its helper copy to say meetings including these people won't be recorded *at all* (manual or automatic), not just auto-skipped.

### Verification
- `tsgo --noEmit` clean.
- Manual: with a blocked attendee on a calendar event, pasting that event's link is refused with the named message; a link with no blocked attendee still records.
- Review the webhook `leaveBot` + `failed` path (full end-to-end needs a live blocked participant with an email exposed by the platform).
