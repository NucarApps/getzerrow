# Calendar cold-email guard

## Goal
If you've had a meeting with someone in Google Calendar (any attendee, last 12 months), their email is never treated as cold — it's forced into your inbox and skips auto-filing folders, AI routing, hide/archive/forward. Controlled by an account-wide toggle in Settings.

## How it behaves
- A new per-Gmail-account toggle: **Keep people I've met in Calendar in my inbox**.
- When on, Zerrow keeps a list of email addresses that have appeared as attendees on your calendar events in the last 12 months.
- Incoming mail from any of those addresses is pinned to the inbox (treated exactly like an existing "always-inbox" override): no folder, no auto-archive, no AI classification.
- Reading the calendar needs a new Google permission, so you reconnect Google once. Until then the toggle shows a "Reconnect to enable" state.

## What the user does
1. In Settings, flip the calendar guard toggle on the relevant Gmail account.
2. If calendar access isn't granted yet, click **Reconnect Google** (one-time consent).
3. Zerrow runs an initial calendar sync (12 months) and then refreshes daily.

```text
Google Calendar (12mo of events)
        │  attendees' emails
        ▼
 calendar_contacts (per account)
        │
incoming email ── from_addr in calendar_contacts? ──► force INBOX, no folder, skip AI
        else ──► normal filter/AI routing
```

---

## Technical details

### 1. OAuth scope + reconnect detection
- `src/lib/google-oauth.server.ts`: add `https://www.googleapis.com/auth/calendar.readonly` to `GMAIL_SCOPES`. (`prompt: "consent"` already forces re-consent, so reconnect grants it.)
- In the OAuth callback (`src/routes/api/public/google-oauth-callback.ts`), the token exchange already returns a `scope` string. Persist whether calendar was granted onto the account (`calendar_access = scope.includes("calendar.readonly")`).
- Existing connected accounts simply have `calendar_access = false` until they reconnect — handled gracefully (guard stays inert, UI prompts reconnect).

### 2. Schema (migration)
- New column on `gmail_accounts`: `calendar_guard_enabled boolean not null default false`, `calendar_access boolean not null default false`, `calendar_synced_at timestamptz null`.
- New table `public.calendar_contacts`:
  - `id uuid pk`, `user_id uuid`, `gmail_account_id uuid`, `email_address text` (lowercased), `last_seen_at timestamptz`, `created_at`.
  - Unique on `(gmail_account_id, email_address)`.
  - RLS: user can select their own rows (`auth.uid() = user_id`); writes happen server-side via the admin client. GRANTs: `SELECT` to `authenticated`, `ALL` to `service_role`.
  - Email addresses stored in plaintext, consistent with the existing `contacts.email` column.
- Add `calendar_contacts` to the deletion list in `deleteAccount` (`src/lib/account.functions.ts`) so CASA data-deletion stays complete.

### 3. Calendar sync (server-only)
- New `src/lib/calendar.server.ts`:
  - `listCalendarEvents(accountId, { timeMin, pageToken })` — calls Google Calendar API `/calendar/v3/calendars/primary/events` reusing `getAccessToken(accountId)` (same per-user OAuth pipeline as Gmail). Pagination + 20s timeout, mirroring `gmail.server.ts` error handling.
  - `syncCalendarContacts(accountId, userId)` — fetches events from now−12 months forward, collects every attendee email (excluding the account's own address), upserts into `calendar_contacts` with `last_seen_at`. Per-call page cap so one run can't hammer the API; resumes on the next tick if needed.
- New `src/lib/calendar.functions.ts` (`createServerFn`, auth-protected):
  - `setCalendarGuard({ accountId, enabled })` — verifies ownership, updates `calendar_guard_enabled`, busts account context, triggers an initial `syncCalendarContacts` when turning on (if `calendar_access`).
  - `getCalendarGuardStatus({ accountId })` — returns `{ enabled, calendarAccess, syncedAt, contactCount }` for the UI.

### 4. Periodic refresh (cron)
- New `src/routes/api/public/hooks/sync-calendar-contacts.ts` guarded by `isAuthorizedCronRequest` (CRON_SECRET), iterating accounts with `calendar_guard_enabled = true AND calendar_access = true`, calling `syncCalendarContacts`. Daily schedule via `pg_cron` (added with the insert tool, not migration). Skips/space-bounds like the other tick endpoints.

### 5. Classification hook (the guard itself)
- `src/lib/sync/account-context.ts`: extend `AccountContext` with `calendarGuardEnabled: boolean` and `calendarContacts: Set<string>` (lowercased emails). Load the flag from the account row and, when enabled, the `calendar_contacts` emails for that account. Cached with the existing 5s TTL; invalidated on toggle change.
- `src/lib/sync/classify.ts`: before the inbox-override logic, if `context.calendarGuardEnabled && context.calendarContacts.has(fromAddr)`, short-circuit exactly like the existing `overrideWins` allowlist path — `folder_id = null`, `classified_by = "calendar_contact"`, `classification_reason = "Met in Google Calendar"`, skip AI. `process-message` already restores INBOX when `classified_by` indicates an inbox pin and Gmail had archived it — extend that branch to also cover `"calendar_contact"`.
- **Filter engine stays pure** — no Supabase imports added there; the guard lives in the classifier, not `filter-engine.ts`.

### 6. UI (Settings)
- New `src/components/settings/CalendarGuardCard.tsx` rendered per selected account in `settings.tsx`:
  - shadcn `Switch` for the toggle, `getCalendarGuardStatus` via React Query.
  - When `calendarAccess` is false: show "Reconnect Google to enable" using the existing `startConnectGmail` reauthorize flow (with `login_hint` = account email).
  - Show last synced time and the number of "people met" plus a **Sync now** button (calls a small server fn wrapper around `syncCalendarContacts`).
  - Sentence-case copy, friendly tone.

### 7. Tests
- Unit test for an `extractAttendeeEmails(event, selfEmail)` helper in `calendar.server.ts` (pure parsing of the events payload).
- Extend `sync-classify`-style coverage: an email from a calendar contact is pinned to inbox (`classified_by === "calendar_contact"`) and skips folder/AI; with the guard off it routes normally.

## Notes / scope
- Adding `calendar.readonly` is a sensitive scope and is part of what Google verifies for your CASA/OAuth review — worth listing it in the verification scope justification.
- This is a server-side-only Calendar read; the client never sees the token (consistent with the Gmail pipeline).
- No changes to job-claim RPCs, encryption, or the Pub/Sub webhook.
