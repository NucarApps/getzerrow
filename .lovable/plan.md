## What's actually happening

The toast you're seeing — `Gmail account is missing OAuth tokens — user needs to reauthorize` — is thrown by `getAccessToken` in `src/lib/google-oauth.server.ts` for both of your Gmail accounts (`chris@nucar.com` and `tpercoco@nucar.com`). Their `refresh_token_enc` column is `NULL`, so any action that needs Gmail (search, sync, renew watch, backfill) fails immediately.

The only fix is to re-run the Google OAuth consent flow so Google hands us a fresh `refresh_token`. That code already exists (`startConnectGmail` → `buildAuthorizeUrl` with `prompt=consent`, and the callback upserts on `(user_id, email_address)` so it refills tokens on the existing row without creating a duplicate).

**The problem is the UI hides the reconnect button.** In `src/routes/_authenticated/settings.tsx` the "Reauthorize Gmail" button only renders when `accounts.length === 0`. Since you have two broken-but-present accounts, there's no clickable path to fix this without deleting them first (which would also wipe per-account settings).

## Plan

### 1. `src/lib/gmail.functions.ts`

- Extend `listMyGmailAccounts` to also return a `needs_reauth: boolean` for each account, computed from `refresh_token_enc IS NULL` (a tiny `EXISTS` check via a dedicated RPC, or by adding a boolean column to a read-only view — I'll use a SQL function that returns `(id, ..., refresh_token_present bool)` so we never expose the ciphertext).
- Extend `startConnectGmail` to accept an optional `{ login_hint?: string }` and pass it through to `buildAuthorizeUrl` (already supported by the underlying helper). This lets a per-account "Reconnect" button send the user straight to the right Google account.

### 2. `src/routes/_authenticated/settings.tsx`

- Always show a top-level **"Reconnect Gmail"** button in the Connected Gmail accounts header (remove the `accounts.length === 0` gate).
- For each account card, when `needs_reauth === true`:
  - Show a small destructive **"Reconnect required"** badge next to the email.
  - Show a primary **"Reconnect"** button in the action row that calls `startConnectGmail({ login_hint: a.email_address })` so Google pre-selects the right account.
- Keep the existing "No Gmail connected yet" empty state for the truly-empty case.

### 3. Tiny SQL helper (migration)

Add a SQL function `list_my_gmail_accounts_with_status()` that returns the same columns `listMyGmailAccounts` already selects plus `refresh_token_present boolean`. We do this in SQL (not JS) so the ciphertext column never leaves the database. RLS is enforced via `SECURITY DEFINER` with an explicit `auth.uid()` filter, matching the pattern used by the other `get_*` RPCs.

## After the code change — what you do

Click **Reconnect** on `chris@nucar.com`, complete Google consent (you may see "Zerrow wants to access your Gmail" — that's the `prompt=consent` step that mints the refresh token), then do the same for `tpercoco@nucar.com`. After that, `from:Bill_Baker@reyrey.com` and background sync will work again.

## Out of scope

- Token storage / encryption / OAuth callback — unchanged.
- Search parser / filter engine — unchanged.
- Background sync logic — unchanged; it will start working the moment refresh tokens exist.
