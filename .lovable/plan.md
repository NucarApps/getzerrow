## Goal

Add a hidden-but-linked `/admin` route only visible to **chris@nucar.com** that shows signups, Gmail connection status, per-user usage volume, and 30-day activity trends.

## Access control

- Email check happens server-side, not in the client. `ADMIN_EMAILS = ["chris@nucar.com"]` constant lives in `src/lib/admin.functions.ts`.
- A helper `assertAdmin(context)` runs inside every admin server fn: pulls the verified email from `context.claims.email` (already set by `requireSupabaseAuth`) and throws `Response("Forbidden", { status: 403 })` if it isn't in the allow-list.
- The `/admin` page also calls one lightweight `getAdminMe()` server fn on mount; if it 403s the page redirects to `/inbox`. The sidebar link only renders when that query succeeds (so other users won't even see it).

## Server functions — `src/lib/admin.functions.ts`

All use `requireSupabaseAuth` + `assertAdmin` and query via `supabaseAdmin` (RLS bypass needed to read across users).

1. **`getAdminMe()`** — returns `{ email }` if admin, throws 403 otherwise. Drives sidebar link visibility.
2. **`listAdminUsers()`** — for each user: email, signup date (`auth.users.created_at`), last sign-in (`auth.users.last_sign_in_at`), counts of emails, folders, contacts, message_jobs (pending/running/dlq), and gmail account info (email_address, last_poll_at, last_push_at, watch_expiration, history_id present). Uses `supabaseAdmin.auth.admin.listUsers()` plus aggregated SQL via a single RPC `admin_user_stats()` we create in the migration (one round-trip, returns one row per user_id).
3. **`getAdminActivity()`** — daily series for the last 30 days: signups per day (from auth.users), emails ingested per day (from emails.created_at). Returned as `{ signups: {date, count}[], emails: {date, count}[] }`. Uses a SQL RPC `admin_daily_activity()`.

## Database — new migration

Add two SECURITY DEFINER RPCs (search_path = public) so the server fns don't have to fan out N queries:

- `admin_user_stats()` → table of `(user_id, email_count, folder_count, contact_count, jobs_pending, jobs_running, jobs_dlq)`. No direct RLS exposure — only callable via `supabaseAdmin` from server fns (we'll `REVOKE EXECUTE FROM anon, authenticated` and `GRANT EXECUTE TO service_role`).
- `admin_daily_activity(p_days int default 30)` → table of `(day date, signups int, emails int)`.

No new tables, no policy changes elsewhere.

## UI

**`src/routes/_authenticated/admin.tsx`** — new page.
- Header: "Admin" with total user count, total emails, total contacts.
- **Activity over time** — two small line charts (signups/day, emails/day) using `recharts` (already in shadcn ecosystem; add if missing).
- **Users table** — sortable columns: Email, Signed up, Last sign-in, Gmail connected (icon + email), Last sync, Emails, Contacts, Folders, Jobs (pending / dlq). Color the "Last sync" cell red if >24h.
- Loading skeletons + empty/error states. 403 → redirect to `/inbox` with toast.

**Sidebar link — `src/routes/_authenticated.tsx`**
- Add an "Admin" entry below "Settings", only rendered when `getAdminMe()` resolves successfully. Uses `Shield` icon from lucide.

## Out of scope

- Per-user drill-down page (just the table for v1).
- Impersonation / "view as user".
- CSV export.
- Changing admin allow-list from the UI (edit the constant in code; can promote to a DB table later).
