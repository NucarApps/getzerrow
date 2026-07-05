## Goal

When a meeting finishes and has no real title (blank, or the generic `"In-person meeting"` placeholder), automatically generate a short, descriptive title from its summary/transcript — so the list stops showing "Untitled meeting" / "In-person meeting".

## Where titles come from today

- **In-person recordings** — `createInPersonMeeting` inserts `title: data.title?.trim() || "In-person meeting"`; the summary is generated later in `finalizeInPersonMeeting` (`src/lib/meetings.server.ts`).
- **Bot recordings from a pasted link** — `recordFromLink` inserts `title: data.title ?? null`; summary is generated in `syncMeetingFromRecall` when the bot reaches `done`.
- **Calendar auto-join** — already gets a real title from the calendar event summary, so it needs no change.

## Changes

### 1. Add a title generator helper (`src/lib/meetings.server.ts`)

New `generateMeetingTitle(sourceText, apiKey)`:
- Uses the existing Lovable AI Gateway provider (same `createLovableAiGatewayProvider` + `SUMMARY_MODEL` already used for summaries).
- Prompt: produce one concise, specific title (max ~8 words, sentence case, no quotes/trailing punctuation) from the transcript/summary.
- Trims and hard-caps the result to ~120 chars; returns `null` on any failure so it never blocks finalization.
- Add a small `needsAutoTitle(title)` predicate: true when title is null, empty, or equals the generic placeholder `"In-person meeting"`.

### 2. In-person path (`finalizeInPersonMeeting`)

- Include `title` in the meeting select.
- After the transcript/summary are ready, if `needsAutoTitle(meeting.title)`, call `generateMeetingTitle` (using the summary, falling back to the transcript text) and add `title` to the final `update`. Keep the existing placeholder if generation returns null.

### 3. Bot recording path (`syncMeetingFromRecall`)

- Add `title` to the `MeetingRow` type and the select in the reconcile/webhook callers that build that row.
- When `status === "done"` and a transcript was produced, if `needsAutoTitle(meeting.title)`, generate a title from the summary and set `update.title`.

### 4. No UI change required

`meetings.tsx` already falls back to "Untitled meeting" when title is null; once the row is updated the real title shows on the next data refresh.

## Technical notes

- All generation stays server-side (server functions / server helpers), consistent with the "never call AI from the client" rule.
- Best-effort only: any AI error is logged and the meeting still finalizes with its existing/placeholder title.
- Reuses the existing summary model and provider — no new secrets or dependencies.

## Verification

- Typecheck with `tsgo --noEmit`.
- Record a short in-person meeting with no title and confirm the list shows a generated title instead of "In-person meeting" after processing.
