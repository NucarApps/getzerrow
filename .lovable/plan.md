## Goal

Each user signs in and connects **their own** Gmail inbox. Real-time updates flow via Pub/Sub push to a webhook, with polling as the fallback.

## Two-layer auth model

We keep these concerns separate:

1. **App sign-in** — stays as Lovable Cloud Google sign-in (already working). Identifies *who the user is*.
2. **Gmail authorization** — new, separate OAuth flow against **your own** GCP OAuth client, requesting Gmail scopes. Stores per-user `access_token` + `refresh_token` server-side. Identifies *which inbox to read*.

This is the standard pattern (Superhuman, Shortwave, etc.) and required by Google — Gmail scopes (`gmail.modify`, `gmail.readonly`) must be granted by each end-user through your own verified OAuth client.

## What you need to set up in GCP (one-time, manual)

You'll do this in console.cloud.google.com — I can't do it for you:

1. Create a GCP project (or use an existing one).
2. Enable the **Gmail API** and **Cloud Pub/Sub API**.
3. **OAuth consent screen**: set to *External*, add scopes `gmail.modify`, `gmail.readonly`, `gmail.send`, `openid`, `email`, `profile`. Add yourself as a test user. (For broad release later you'd submit for verification — for personal/small use, leaving in Testing mode is fine, max 100 users.)
4. **Create OAuth 2.0 Client ID** (Web application). Authorized redirect URI: `https://<your-published-domain>/api/public/google-oauth-callback` (and the preview URL too while developing). Note `client_id` and `client_secret`.
5. **Create a Pub/Sub topic** `gmail-push` and grant `gmail-api-push@system.gserviceaccount.com` the *Pub/Sub Publisher* role on it.
6. **Create a Push subscription** on that topic with endpoint `https://<your-published-domain>/api/public/gmail-webhook`.

Once that's done I'll need three secrets added to the project: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GMAIL_PUBSUB_TOPIC` (full path like `projects/your-gcp/topics/gmail-push`).

## What I'll build

### 1. Database

New table `gmail_accounts` (one row per connected Gmail per app user):

- `user_id` → `auth.users`
- `email_address`
- `access_token`, `refresh_token`, `token_expires_at`
- `history_id`, `watch_expiration`
- RLS: user can only see/edit their own row

Migrate `sync_state` from singleton-row-id-1 to one row per `gmail_accounts.id`. Update `emails`, `folders`, `folder_examples` to scope by `gmail_account_id` (already scoped by `user_id`, just add the FK).

### 2. OAuth flow

- New route `/settings/connect-gmail` — button that redirects to Google's consent screen with `access_type=offline&prompt=consent` (forces refresh token).
- New server route `/api/public/google-oauth-callback` — exchanges the auth code for tokens, fetches the user's email address, inserts/updates `gmail_accounts`, immediately starts a Gmail `watch` against your Pub/Sub topic, redirects back to settings.

### 3. Replace `gmail.server.ts`

Currently it goes through `connector-gateway.lovable.dev` with `GOOGLE_MAIL_API_KEY`. Rewrite to call `https://gmail.googleapis.com/gmail/v1/...` directly with the per-user bearer token.

Add a `getAccessToken(accountId)` helper that:
- Returns the stored token if it's >2 min from expiry.
- Otherwise calls Google's token endpoint with the refresh token, updates the DB, returns the new one.

Every existing function (`listMessages`, `getMessage`, `modifyMessage`, `sendMessage`, `listHistory`, `watchInbox`, `stopWatch`, `listLabels`, `createLabel`, `trashMessage`) takes `accountId` as the first argument now.

### 4. Pub/Sub webhook

`/api/public/gmail-webhook` already exists but currently grabs "the first user". Rewrite to:
- Decode the Pub/Sub envelope → `{ emailAddress, historyId }`.
- Look up `gmail_accounts` by `email_address`.
- Call `syncSinceHistory(accountId)` for that account.

Optional but recommended: verify the Pub/Sub JWT in the `Authorization` header (Google signs push messages). Quick and prevents anyone from spamming the endpoint.

### 5. Settings UI

- Replace the "Inbox sync" card with a "Connected Gmail accounts" list showing each connected address, watch status, last sync time, and a Disconnect button.
- "Connect Gmail" button kicks off the OAuth flow.
- Existing Backfill / Sync now buttons take an `accountId`.

### 6. Migration of existing data

You currently have emails synced via the shared connector. Options:
- **Wipe and resync** — simplest, given this is a personal-use app. After you connect your Gmail through the new flow, click Backfill.
- **Backfill-then-merge** — keep existing rows, attach them to the new `gmail_account_id` once your address matches.

I'd recommend wiping — 30 emails comes back in seconds.

## Files changed (preview)

- New: `supabase/migrations/...` (gmail_accounts + FK updates)
- New: `src/routes/api/public/google-oauth-callback.ts`
- New: `src/lib/google-oauth.server.ts` (token exchange + refresh)
- Rewritten: `src/lib/gmail.server.ts` (direct Gmail API, per-account)
- Rewritten: `src/lib/sync.server.ts` (accountId-aware)
- Rewritten: `src/routes/api/public/gmail-webhook.ts` (proper account lookup)
- Updated: `src/lib/gmail.functions.ts` (all fns take accountId)
- Updated: `src/routes/_authenticated/settings.tsx` (account list + connect button)
- Updated: `src/routes/_authenticated/folders.tsx` (scope by accountId)
- Removed: dependency on `GOOGLE_MAIL_API_KEY` connector secret

## Order of execution

1. You set up GCP (steps 1–6 above) and tell me when done.
2. I request the 3 secrets (`GOOGLE_OAUTH_CLIENT_ID`, `_SECRET`, `GMAIL_PUBSUB_TOPIC`).
3. DB migration.
4. OAuth flow + token refresh.
5. Rewrite gmail.server.ts to direct API.
6. Rewrite webhook + sync.
7. Update UI.
8. You click "Connect Gmail" → authorize → backfill.

## Scope of this plan

- ✅ Per-user Gmail via your GCP
- ✅ Real-time Pub/Sub push
- ✅ Token refresh
- ❌ Google OAuth app verification (you can run in Testing mode for now)
- ❌ Multi-Gmail-per-user (one inbox per app user — straightforward to extend later)
