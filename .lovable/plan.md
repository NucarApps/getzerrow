## Goal

In the meeting detail panel, let the user click the meeting title to edit it inline, and add a sparkles (AI) button that regenerates the title from the meeting's summary/transcript on demand.

## Current state

- The title shows as a static `<span>` in the `MeetingDetail` sheet header (`src/routes/_authenticated/meetings.tsx`, ~line 1040): `{meeting.title || "Untitled meeting"}`.
- `getMeeting` already returns the full row (summary + transcript).
- There is no server function to rename a meeting or to generate a title on demand — auto-titling only runs during finalization inside `generateMeetingTitle` (`src/lib/meetings.server.ts`, currently a private helper).

## Changes

### 1. Export the title generator (`src/lib/meetings.server.ts`)

Change `generateMeetingTitle` from a private function to an exported one so the on-demand server function can reuse the exact same prompt/model. No behavior change.

### 2. Two new server functions (`src/lib/meetings.functions.ts`)

Both use `requireSupabaseAuth` so the authenticated (RLS-scoped) client enforces ownership.

- `renameMeeting({ id, title })` — validate `id` (uuid) and `title` (string, max 200). Trim it; an empty string saves `null` (falls back to "Untitled meeting"). Update the row via `context.supabase` and return `{ title }`.
- `generateTitleForMeeting({ id })` — read the meeting's `summary` and `transcript` via `context.supabase`. If there's no summary or transcript text, throw a friendly error ("Add a recording first — there's nothing to base a title on yet."). Otherwise dynamically import `generateMeetingTitle` from `./meetings.server`, generate from `summary || transcript text`, persist the new title via `context.supabase`, and return `{ title }`. If generation returns null, throw a friendly "Couldn't generate a title, try again" error.

### 3. Inline editable title + sparkles button (`src/routes/_authenticated/meetings.tsx`)

In `MeetingDetail`:
- Wire `useServerFn(renameMeeting)` and `useServerFn(generateTitleForMeeting)`.
- Replace the static title span in `SheetTitle` with an editable control:
  - Default: the title text rendered as a button-like element; clicking it switches to an `<Input>` seeded with the current title.
  - Save on Enter or blur via `renameMeeting`; Escape cancels. On success, invalidate `["meeting", id]` and `["meetings"]` and toast.
  - A small ghost icon button with the `Sparkles` icon (lucide) next to the title. Clicking calls `generateTitleForMeeting`, shows a spinner while pending, then invalidates the same queries and toasts. Disable it (with a title/tooltip) while the meeting has no summary/transcript yet.
- Keep the `StatusBadge` in the header row.

### 4. No schema changes

`meetings.title` already exists and is nullable.

## Technical notes

- All AI generation stays server-side, reusing the existing Lovable AI provider and summary model — no new secrets or dependencies.
- Editing and generation are RLS-scoped through `requireSupabaseAuth`; no service-role access needed.
- `Sparkles` and `Input` are already available from lucide-react / shadcn.

## Verification

- Typecheck with `tsgo --noEmit`.
- In preview: open a finished meeting, click the title to rename it (Enter saves), then click the sparkles button and confirm the title updates from the summary.
