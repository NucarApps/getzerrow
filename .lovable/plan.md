## Problem

After reconnecting `chris@nucar.com`, the UI still shows "Contacts permission not granted." The DB confirms the reconnect succeeded (`needs_reconnect=false`, `last_oauth_error=null`), but `google_sync_state.last_error` is still the stale `missing_contacts_scope` from before the reconnect. Nothing on the OAuth-callback path clears it or re-checks the granted scope, so the warning sticks until the next reconcile happens to run and either clear or re-affirm it.

## Fix

Make the OAuth callback authoritative about contacts access, the same way it already is for calendar.

### 1. Persist granted contacts scope on the account
- Add `scopeGrantsContacts(scope)` helper in `src/lib/google-oauth.server.ts` (mirrors `scopeGrantsCalendar`).
- Add a `contacts_access boolean` column on `gmail_accounts` (migration + GRANT preserved).
- In `src/routes/api/public/google-oauth-callback.ts`, when updating `calendar_access`, also update `contacts_access` from `tokens.scope`.

### 2. Reset stale contacts-sync error on reconnect
In the callback, after `clearNeedsReconnect(account.id)`:
- If contacts scope IS granted → update the account's `google_sync_state` row: `last_error = null` (only when it was `missing_contacts_scope` or `needs_reconnect`), so the banner clears immediately.
- If contacts scope is NOT granted → set `google_sync_state.last_error = 'missing_contacts_scope'` right away so the UI shows the correct state without waiting for a reconcile.

### 3. Surface a clearer message when Google actually withheld the scope
In `src/routes/_authenticated/settings.google-contacts.tsx`, drive the warning from `account.contacts_access` (new column) instead of only `last_error`. Copy update when `contacts_access === false` after a reconnect: "Google did not grant Contacts access. On the consent screen make sure the 'See, edit, download, and permanently delete your contacts' checkbox is ticked, then reconnect." This distinguishes "user unchecked the box" from "stale error".

### 4. Kick a sync right after reconnect
Also in the callback, best-effort call the existing contacts reconcile enqueue for that account when contacts scope is present, so the first pull happens without the user clicking "Sync now".

## Out of scope

- No changes to the OAuth scope list itself (contacts scope is already requested).
- No changes to reconcile logic beyond reading the same `contacts_access` flag if convenient.

## Verification

1. Query `gmail_accounts` for chris@nucar.com — `contacts_access` reflects the last OAuth grant; `google_sync_state.last_error` is `null` when the scope is granted.
2. UI shows the red banner only when `contacts_access = false`, with the new "consent-screen checkbox" copy.
3. Reconnect with the Contacts checkbox ticked → banner disappears immediately, first pull runs.
