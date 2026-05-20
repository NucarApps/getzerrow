## Goal

Let users set up one or more **daily AI summaries per folder**. At each scheduled time, Zerrow reads the last 24h of emails in that folder, runs them through the AI with the user's grouping instructions, and inserts a formatted digest directly into their Gmail Inbox (via `messages.insert` — no real send, no recipient picker, no auto-classification).

## Data model — new table `folder_summary_schedules`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | uuid | RLS = `auth.uid()` |
| `folder_id` | uuid | references `folders.id` (logical) |
| `gmail_account_id` | uuid | denormalized from folder for fast lookups |
| `name` | text | e.g. "Morning newsletter digest" |
| `instructions` | text | grouping/formatting prompt the user writes |
| `hour` | int (0–23) | local hour in `timezone` |
| `minute` | int (0–59) | |
| `timezone` | text | IANA tz, defaults to browser tz on create |
| `enabled` | bool default true | |
| `last_run_at` | timestamptz nullable | |
| `next_run_at` | timestamptz | computed on insert/update via helper |
| `last_error` | text nullable | surfaced in UI |
| `created_at`, `updated_at` | timestamptz | standard |

RLS: `auth.uid() = user_id` for ALL. Standard `set_updated_at` trigger.

No changes to existing tables.

## Scheduling — single pg_cron tick

One global pg_cron job, every 5 minutes, calls a public hook route. The hook fans out to all schedules with `enabled = true AND next_run_at <= now()`. After running a schedule, the hook updates `last_run_at = now()` and recomputes `next_run_at` to the next occurrence of `hour:minute` in `timezone` strictly in the future.

```
cron: */5 * * * * → POST {project-prod-url}/api/public/hooks/run-folder-summaries
                      headers: { apikey: <SUPABASE_PUBLISHABLE_KEY> }
                      body:    {}
```

The cron job and the route handler use the documented anon-key/`apikey` header pattern — no custom shared-secret env var.

## Server route — `src/routes/api/public/hooks/run-folder-summaries.ts`

- POST handler, validates `apikey` header matches `SUPABASE_PUBLISHABLE_KEY`.
- Uses `supabaseAdmin` to pick up to 25 due schedules (`enabled = true AND next_run_at <= now()` ordered by `next_run_at`).
- For each schedule, calls `runFolderSummary(scheduleId)` (in a new `src/lib/summaries.server.ts`). Failures are caught per-schedule, logged, and recorded in `last_error`; one bad schedule never blocks others.
- Returns `{ processed, succeeded, failed }`.

## `src/lib/summaries.server.ts` — core logic

`runFolderSummary(scheduleId)`:
1. Load schedule + folder + gmail_account (must belong to same user).
2. Compute window: `[last_run_at ?? next_run_at − 24h, now)`. Pull emails from `emails` where `folder_id = …` and `received_at` in that window, ordered by `received_at desc`, capped at 200.
3. If 0 emails: skip the insert but still advance `next_run_at`. Set `last_error = null`.
4. Call `summarizeFolderEmails({ folder, instructions, emails })` (new helper in `src/lib/ai.server.ts`) — returns `{ subject, body_text, body_html }`. Uses `google/gemini-2.5-flash`, prompt includes the folder name, user instructions, and a compact list (from, subject, snippet, received_at) per email. Returns structured JSON via `Output.object`.
5. Build an RFC 2822 message: From = the account's `email_address`, To = same address, Subject = AI subject, multipart with text + HTML. Use `gmail.users.messages.insert` (new helper `insertMessage` in `gmail.server.ts`) with `internalDateSource=dateHeader` and labels `['INBOX', 'UNREAD']` so it appears as a fresh unread email.
6. Update schedule row: `last_run_at = now()`, `next_run_at = computeNext(...)`, `last_error = null`.
7. On any thrown error: `last_error = err.message`, advance `next_run_at` (to avoid hot-looping), let the route catch and continue.

`computeNextRun(hour, minute, tz, fromUtc)`: pure helper, uses `Intl.DateTimeFormat` with the given IANA tz to find the next UTC instant whose local time equals `hour:minute`. Returns ISO string.

The generated email is intentionally left unclassified: the existing classifier will see it as a normal inbound and route it (or leave it in Inbox) per the user's existing rules — matching the user's stated preference.

## Server functions — `src/lib/gmail.functions.ts`

Auth-protected (`requireSupabaseAuth`) wrappers used by the UI:

- `listFolderSummaries({ folder_id })` → rows for that folder.
- `createFolderSummary({ folder_id, name, instructions, hour, minute, timezone })` → validates ownership, computes `next_run_at`, inserts.
- `updateFolderSummary({ id, name?, instructions?, hour?, minute?, timezone?, enabled? })` → recomputes `next_run_at` if time/tz/enabled changed.
- `deleteFolderSummary({ id })`.
- `runFolderSummaryNow({ id })` → ownership check, then calls `runFolderSummary(id)` directly; returns `{ ok, error? }` so the UI can show success / show the error inline.

All validated with zod (string lengths capped, hour 0–23, minute 0–59, IANA tz regex).

## UI — extend `src/components/folders/FolderEditor.tsx`

Add a new collapsible section to the **Settings** tab titled **"Daily summaries"**, below "Learned profile":

- List of existing schedules. Each row:
  - Name, "every day at HH:MM (TZ)", enabled switch, "Run now" button, edit, delete.
  - If `last_error`, show a destructive-tinted note with the message.
  - Show `last_run_at` and `next_run_at` in muted text.
- "Add schedule" button → inline form: name, time picker (hour + minute), tz select (defaulted to `Intl.DateTimeFormat().resolvedOptions().timeZone`, with a small curated list + "other" free text), instructions textarea (placeholder: "Group by sender, surface action items, keep it under 10 bullets"), save/cancel.

No other tabs/pages change. The History tab from the previous turn is unaffected.

## Migration + cron

One migration creates `folder_summary_schedules`, RLS policies, `updated_at` trigger, helpful index on `(enabled, next_run_at)`. The pg_cron `cron.schedule(...)` insertion is run via the data tool (anon key + URL are project-specific), not the migration tool.

## Out of scope

- Weekly / hourly / custom-cron cadences (deferred — only daily for now per user choice).
- Sending to other addresses.
- Routing the summary email into a specific folder.
- A global "Summaries" dashboard.

## Technical notes

- `messages.insert` accepts an RFC 822 raw message and a `labelIds` array. It does NOT send anything externally — perfect fit for "insert directly into Inbox".
- The cron tick + per-schedule `next_run_at` model lets us add weekly/hourly later without restructuring.
- Lookback window keys off `last_run_at` (with a 24h fallback) so manually-disabled-then-re-enabled schedules don't double-cover or miss days.
- The AI call is bounded: max 200 emails × ~300 chars of subject+snippet each = well within the model's context. No streaming needed.
- The hook validates `apikey === SUPABASE_PUBLISHABLE_KEY` and rejects otherwise, so accidental public traffic can't trigger summaries.
