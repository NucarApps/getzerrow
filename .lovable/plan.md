# Google Contacts sync — finish the wiring

The core sync modules (`mapper`, `people-client`, `state`, `pull`, `push`, `reconcile`) already exist under `src/lib/google-contacts/`. This plan bolts on everything needed to actually run them end-to-end for a user.

## 1. OAuth scope extension

- Add `https://www.googleapis.com/auth/contacts` to the Gmail OAuth consent scopes (wherever the auth URL is built and wherever tokens are refreshed).
- On next connect / re-auth, tokens will include contacts scope. Existing accounts keep working for mail, but a `needs_reconnect` flag will be set the first time People API returns 403; the ReconnectBanner already surfaces that.
- No schema change — reuses `gmail_accounts` tokens via the existing `get_gmail_oauth_tokens` RPC.

## 2. "Sync now" server fn

- New `syncGoogleContactsNow` in `src/lib/google-contacts.functions.ts`:
  - `requireSupabaseAuth`, takes `{ accountId }`.
  - Verifies the account belongs to the caller.
  - Calls `reconcileGoogleContacts({ userId, accountId })` from `reconcile.server.ts` (loaded via dynamic import to keep server-only code out of the client graph).
  - Returns `{ pulled, pushed, deleted, error? }` for the UI toast.
- Second fn `getGoogleContactsSyncStatus({ accountId })` returns the row from `google_sync_state` (last sync at, last error, next allowed run) for the settings panel.

## 3. Cron hook

- New public route `src/routes/api/public/hooks/google-contacts-sync.ts`:
  - `POST` handler, verifies `apikey` header matches `SUPABASE_ANON_KEY` (matches other cron hooks in the project).
  - Loads all `gmail_accounts` where contacts scope is granted and `google_sync_state.next_allowed_at <= now()`.
  - For each, `await reconcileGoogleContacts(...)` inside a try/catch so one bad account doesn't halt the batch.
  - Returns `{ ran, ok, errors }`.
- Migration adds a `pg_cron` job that hits this route every 15 min using `pg_net.http_post` with the anon key (same pattern as `tasks-completion-scan`).

## 4. Settings UI

- New route `src/routes/_authenticated/settings.google-contacts.tsx`:
  - Lists connected Gmail accounts with their sync state (last sync, last error, "Enabled" toggle backed by a new `google_contacts_sync_enabled` column on `gmail_accounts`, default false).
  - "Sync now" button per account → `syncGoogleContactsNow`, shows toast with counts.
  - Reconnect CTA when `needs_reconnect` is set — reuses the existing Google OAuth start URL with the new contacts scope appended.
  - Short explainer: two-way sync, groups mapped to Google Labels, deletions propagate.
- Add a nav link from `settings.carddav.tsx` sidebar / settings index so users can find it.

## 5. Small schema addition

Single migration:
- `gmail_accounts.google_contacts_sync_enabled boolean not null default false`.
- Backfill: leave false — users opt in from the settings UI.
- Cron route skips accounts where the flag is false.

## Out of scope for this turn

- Field-level conflict UI (last-write-wins remains, surfaced via `last_error`).
- Photo sync (People API photos need a separate binary upload path).
- Selective group sync (all groups sync; hide-from-sync toggle can come later).
