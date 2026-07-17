## Google Contacts two-way sync (People API)

Sync every Zerrow contact with the user's Google Contacts account, and map Zerrow contact groups ↔ Google contact labels — two-way, per user.

Google no longer supports CardDAV, so this goes through the **Google People API** using the same OAuth connection each user already has for Gmail. We just add one extra scope; no new connector, no separate sign-in.

### 1. Extend Gmail OAuth with the Contacts scope

- Add `https://www.googleapis.com/auth/contacts` to `GMAIL_SCOPES` in `src/lib/google-oauth.server.ts` and to the login prompt list in `src/routes/login.tsx`.
- Existing users get a one-click "Reconnect Google to enable contact sync" banner (reuses the same reconnect flow already used for Calendar). Until they accept, the People API paths short-circuit — Gmail keeps working untouched.

### 2. Schema — track sync state, not shape

New migration adds mapping + tombstone tables, mirroring the CardDAV pattern:

- `google_contact_links` — `(user_id, gmail_account_id, contact_id)` ↔ `resource_name` (`people/c123`) + `etag` + `last_synced_at`. Unique on both `(contact_id)` and `(resource_name)`.
- `google_group_links` — `(user_id, gmail_account_id, contact_group_id)` ↔ `resource_name` (`contactGroups/xyz`) + `etag`.
- `google_sync_state` — per `(user_id, gmail_account_id)` cursor: `people_sync_token`, `groups_sync_token`, `last_full_sync_at`, `last_incremental_at`, `last_error`.
- `google_contact_tombstones` — records local hard-deletes so the next push can DELETE upstream (parallel to `carddav_tombstones`).

All tables: RLS scoped to `auth.uid()`, `GRANT` to `authenticated` + `service_role`, `updated_at` triggers.

### 3. New module: `src/lib/google-contacts/`

Pure-logic pieces stay separate from HTTP:

- `people-client.server.ts` — thin fetch wrappers around People API endpoints we need: `people.connections.list` (with `syncToken`), `people.createContact`, `people.updateContact` (requires `updatePersonFields` + `etag`), `people.deleteContact`, `contactGroups.list`, `contactGroups.create/update/delete`, `contactGroups/{id}/members:modify`. Uses existing Gmail token refresh (`getGmailAccessToken`).
- `mapper.ts` — pure functions `contactToPerson()` / `personToContact()` and `groupToLabel()` / `labelToGroup()`. Handles name splitting, phone/email normalization, and the encrypted-fields boundary (notes/address/primary phone go through `setContactEncryptedFields`, everything else is plaintext columns).
- `pull.server.ts` — incremental pull using `syncToken`. First run does full sync (no token), stores returned `nextSyncToken`. Applies remote changes to local Zerrow rows via existing `contacts` / `contact_phones` / `contact_group_members` writers. Handles Google's `410 EXPIRED_SYNC_TOKEN` by falling back to a full resync.
- `push.server.ts` — walks local changes since `last_incremental_at`: creates/updates people whose `google_contact_links` row is missing or stale, deletes people listed in `google_contact_tombstones`, syncs group membership diffs via `contactGroups/members:modify`.
- `reconcile.server.ts` — the orchestrator: `runGoogleContactsSync(userId, accountId)` = pull → push → clear tombstones → bump cursor. All-or-nothing per account, wrapped in structured logs matching the sync/log pattern (`run_id`, `account_id`, phases: `pull`, `push`, counts, errors).

### 4. Conflict handling (two-way)

- **Field conflicts**: last-write-wins on the modified field, compared via `updated_at` on our side vs People `metadata.sources[].updateTime` on Google's. Never overwrite the encrypted `notes` field unless Google's `biographies[0]` actually differs from decrypted local (avoids re-encrypting a no-op every sync).
- **Deletes**: local delete → tombstone → push DELETE. Remote delete arrives as a `deleted: true` connection in the sync feed → soft-remove locally (respects existing contact-deletion semantics).
- **Group membership**: diff `contact_group_members` vs Google's `memberships[]`, apply the delta with a single `members:modify` per group per run.
- **Race with CardDAV**: both writers use the same `contacts` primitives, so an iPhone edit → CardDAV writer → next Google push carries it upstream. No coordination needed.

### 5. Scheduling & entry points

- `src/routes/api/public/hooks/google-contacts-sync.ts` — CRON_SECRET-gated tick, every 15 min via pg_cron. Iterates accounts whose `last_incremental_at` is stale, calls `runGoogleContactsSync`, budget-capped like other cron ticks.
- Server fn `syncGoogleContactsNow` (`requireSupabaseAuth`) for a manual "Sync now" button.
- Realtime nudge: when the user creates/edits a contact or group in the app, enqueue a lightweight `google_contact_sync_pending` flag on `google_sync_state` so the next tick prioritizes that account (no per-write API call — avoids rate-limit fragility).

### 6. Settings UI: `src/routes/_authenticated/settings.google-contacts.tsx`

- Connection status per Gmail account: scope granted?, last sync, next sync, counts (contacts up, contacts down, groups synced), last error.
- Buttons: "Reconnect Google" (only if scope missing), "Sync now", "Disable sync" (stops cron, doesn't delete data), "Force full resync" (nulls `people_sync_token`).
- Add a link in the Contacts page header pointing here, next to the existing CardDAV link.

### 7. Tests

- `mapper.test.ts` — round-trip Zerrow contact ↔ People resource, and group ↔ label, with edge cases (unicode names, multi-value phones/emails, empty groups).
- `pull.test.ts` (unit, mocked client) — sync-token happy path, `410 EXPIRED_SYNC_TOKEN` → full resync fallback, deleted-connection handling.
- `push.test.ts` (unit, mocked client) — create/update/delete diff, membership `members:modify` diffing, tombstone cleanup only on success.
- `reconcile.test.ts` — one integration test that runs pull then push against a mocked People API and asserts final DB state + cursor bump.

### Technical notes

- People API rate limit is 90 req/min per user; batch where possible (`batchGet`, `members:modify`), otherwise pace with the same request budget helper used by the Gmail sync.
- `updatePerson` requires listing every field being changed in `updatePersonFields` and passing the current `etag` — we always pull first, then push, so we always have the fresh etag. If we get `FAILED_PRECONDITION` (etag mismatch) we skip that record and let the next pull reconcile.
- Encrypted fields on our side (notes, address, primary phone) must be decrypted with `EMAIL_ENC_KEY` inside the server fn before mapping — never emit ciphertext to Google.
- Everything runs server-side. No People API keys or tokens ever reach the browser.
