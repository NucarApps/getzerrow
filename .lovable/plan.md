## Goal

One Google sign-in flow that (a) authenticates the user via **your** GCP project and (b) connects their Gmail in the same handshake — no second "Connect Gmail" click.

## Strategy

Drop `lovable.auth.signInWithOAuth` on the login page and call **Supabase's** OAuth directly with the Gmail scopes baked in. When Google redirects back, Supabase returns a session that includes `provider_token` (Gmail access token) and `provider_refresh_token` (Gmail refresh token). We pass those to a server function that creates the `gmail_accounts` row, starts the Pub/Sub watch, and backfills.

Why this works:
- Lovable Cloud's Google provider supports BYO Client ID/Secret (you already pasted yours last turn).
- Supabase's `signInWithOAuth` accepts arbitrary Google scopes and forwards `access_type=offline` + `prompt=consent` query params, which is how Google issues refresh tokens.
- `provider_refresh_token` is exposed exactly once per session — we capture it on the very first `SIGNED_IN` event after the redirect.

Result: a single consent screen on your GCP that requests email + profile + Gmail.modify + Gmail.readonly + Gmail.send, and the user is signed in **and** their inbox is connected the moment they land back on the app.

## GCP one-time setup (you'll do this)

In your existing GCP OAuth 2.0 Web client and consent screen:
1. Make sure these scopes are added to the **OAuth consent screen**:
   - `openid`, `.../userinfo.email`, `.../userinfo.profile`
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
2. Confirm the Supabase callback URI is in **Authorized redirect URIs** (added last turn):
   `https://axilcinlnaujxyksfjin.supabase.co/auth/v1/callback`
3. Confirm the Client ID/Secret are saved under Cloud → Users → Auth Settings → Google.

## Code changes

### `src/routes/login.tsx`
- Swap `lovable.auth.signInWithOAuth(...)` for:
  ```ts
  supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin + "/login",
      scopes: "openid email profile https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
      queryParams: { access_type: "offline", prompt: "consent" },
    },
  });
  ```
- In the existing `onAuthStateChange` listener, on `SIGNED_IN` grab `session.provider_token`, `session.provider_refresh_token`, and `session.user.email`, then call a new server fn `connectGmailFromSession({ access_token, refresh_token, expires_in, email })` **before** navigating to `/`. If the user already has a `gmail_accounts` row for that email, we update it instead of inserting (refresh tokens rotate).

### New: `src/lib/gmail.functions.ts` → `connectGmailFromSession`
- Auth-gated server fn. Inputs: `access_token`, `refresh_token`, `expires_in` (seconds), `email_address`.
- Upserts `gmail_accounts` keyed on `(user_id, email_address)`.
- Calls `ensureWatch(account.id, null)` to register Pub/Sub.
- Kicks off `backfillRecent(account.id, userId, 30)` so the inbox isn't empty on first load.
- Returns `{ account_id }`.

### `src/routes/_authenticated/settings.tsx`
- Hide the "Connect Gmail" button when an account is already linked (it'll be linked from sign-in now). Keep the disconnect button so a user can revoke.
- If somehow `provider_refresh_token` was missing (very rare — user previously consented and Google didn't re-issue), show a "Reauthorize Gmail" button that runs the existing `startConnectGmail` flow as a fallback.

### Cleanup
- Remove the now-unused `lovable.auth` import from `login.tsx`. Leave `@/integrations/lovable` in place — other parts of the app may use it.

## Edge cases handled
- **No refresh token returned** (user already consented before in a way that didn't grant Gmail scopes): the `prompt=consent` forces a re-consent so we get one. If it still doesn't come back, server fn returns a typed error and UI surfaces the fallback "Reauthorize Gmail" button.
- **User signs in with a different Google account than their existing `gmail_accounts` row**: we insert a new row instead of overwriting.
- **Subsequent sign-ins**: `connectGmailFromSession` becomes a no-op upsert that just refreshes the stored tokens.

## What this does NOT change
- The existing `/api/public/google-oauth-callback` and `startConnectGmail` flow stays as a fallback for re-authorizing.
- `gmail_accounts` schema is unchanged.
- RLS, sync.server, gmail.server, webhook route — all untouched.

## Before I implement

Confirm both:
1. You pasted your GCP Client ID + Secret into Cloud → Auth → Google last turn.
2. The Gmail scopes are on your OAuth consent screen (or you're OK adding them now).

Reply "go" and I'll ship it.