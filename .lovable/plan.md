# Skip auto-recording meetings with specific people

## Goal
Let you keep a list of people (by email) or whole domains (e.g. your law firm's) that should never be auto-recorded. When the auto-record scheduler looks at an upcoming calendar meeting, if any attendee or the organizer matches your blocklist, it skips sending the notetaker bot — so your attorney calls stay private.

## How it works
- The blocklist lives per user (applies across all your connected inboxes), just like the bot customization settings.
- Entries can be a full email (`jane@lawfirm.com`) or a bare domain (`lawfirm.com`) to block everyone at a firm.
- Matching is case-insensitive: an event is skipped if any attendee/organizer email exactly matches a listed email, or its domain matches a listed domain.
- This only affects *automatic* calendar-based recording. You can still manually record any meeting from a link if you choose.

## What you'll see
A new "Don't auto-record these people" card in Settings → Meetings, under the auto-record toggle:
- A field to add an email or domain, with an "Add" button.
- A list of current entries, each with a remove (×) button.
- Helper copy explaining that meetings including anyone on this list won't be auto-recorded, and that whole domains are supported.

---

## Technical details

### 1. Database (migration)
New table `public.meeting_record_blocklist`:
- `id uuid primary key default gen_random_uuid()`
- `user_id uuid not null` (references the auth user)
- `value text not null` — stored lowercased; either an email or a bare domain
- `created_at timestamptz not null default now()`
- `unique (user_id, value)`

Grants + RLS in the same migration:
- `GRANT SELECT, INSERT, DELETE ON public.meeting_record_blocklist TO authenticated;`
- `GRANT ALL ... TO service_role;` (the cron scheduler reads it via the admin client)
- Enable RLS; policies scoped to `auth.uid() = user_id` for select/insert/delete. No `anon` grant.

### 2. Server functions (`src/lib/meetings.functions.ts`)
All use `.middleware([requireSupabaseAuth])`:
- `listRecordBlocklist` (GET) — returns the caller's entries ordered by value.
- `addRecordBlocklistEntry` (POST) — Zod-validate input: trim + lowercase, accept either a valid email or a bare domain (regex), reject otherwise; upsert on `(user_id, value)`.
- `removeRecordBlocklistEntry` (POST) — delete by `id` scoped to the user.

### 3. Scheduler skip logic (`src/lib/meetings-autojoin.server.ts`)
In `scheduleUpcomingMeetingBots`, per account (keyed by `account.user_id`), load the user's blocklist once (cache per user id within the run to avoid refetching for multiple accounts of the same user). Build a `Set` of blocked emails and a `Set` of blocked domains.

For each event, before creating the bot, collect all attendee emails + organizer email (lowercased). If any email is in the blocked-emails set, or its domain (part after `@`) is in the blocked-domains set, `continue` (skip scheduling) and `logInfo("meeting_autojoin_skipped_blocklist", …)`. This check goes right after `meetingUrl`/existing/excluded checks, reusing the same email parsing already used to build `participants`.

### 4. UI (`src/components/settings/MeetingRecordBlocklistCard.tsx`, new)
A shadcn `Card` following the pattern of `MeetingBotCard`/`MeetingAutoRecordCard`:
- React Query `useQuery` for `listRecordBlocklist`, `useServerFn` wrappers, `useMutation` for add/remove with `invalidateQueries`.
- Input + Add button; validation error toast on bad input; list with remove buttons.
- Friendly, sentence-case copy per brand voice.

Render it in `src/routes/_authenticated/settings.tsx` Meetings tab, right after the `MeetingAutoRecordCard` block (it's user-level, so a single card, not one-per-account).

### Verification
- Typecheck with `tsgo --noEmit`.
- Confirm the card renders in Settings → Meetings and add/remove round-trips.
- Confirm the scheduler skip by reviewing the added `continue` path (full end-to-end needs a live calendar event with a blocked attendee).
