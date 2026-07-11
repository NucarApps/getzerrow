# Fix: "Something went wrong completing sign-in" on Gmail reconnect

## What's actually happening

The reconnect flow hits your callback `/api/public/google-oauth-callback`, which tries to exchange Google's authorization `code` for tokens. Google rejects that exchange:

```text
Token exchange failed 401:
{ "error": "invalid_client",
  "error_description": "The provided client secret is invalid." }
```

The generic "Something went wrong completing sign-in" message is the catch-all around that failure. The same bad credential is also breaking background token refresh (calendar/meeting jobs log the identical `invalid_client` error).

This is a **credentials/config problem, not a code problem.** The `GOOGLE_OAUTH_CLIENT_SECRET` your app stores no longer matches the secret Google Cloud Console holds for the OAuth client identified by `GOOGLE_OAUTH_CLIENT_ID`. This almost certainly traces back to the earlier Google Cloud change (deleted URI / rotated secret).

Note: this is a **separate credential** from your login (Supabase Auth Google provider). Your app's Gmail connect/reconnect flow uses its own `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` secrets. Fixing login earlier did not touch this pair.

## The fix (no code changes)

1. In Google Cloud Console → APIs & Services → Credentials, open the OAuth 2.0 Client ID that matches the value in your app's `GOOGLE_OAUTH_CLIENT_ID` (Web application type).
2. Under **Client secrets**, add a new secret (or copy the current valid one). Copy the full value.
3. While you're there, confirm the **Authorized redirect URI** list still includes:
   - `https://getzerrow.com/api/public/google-oauth-callback`
   - `https://www.getzerrow.com/api/public/google-oauth-callback`
   - `https://getzerrow.lovable.app/api/public/google-oauth-callback`
   (Add any that are missing — a deleted redirect URI would cause a different error, but this guards against a repeat of the earlier issue.)
4. I'll open a secure form (via `update_secret`) so you can paste the new value into `GOOGLE_OAUTH_CLIENT_SECRET`. The value is stored encrypted and never shown in code or chat.
5. After the secret is saved, retry the Gmail reconnect from Settings. Once one account reconnects successfully, the `needs_reconnect` flag clears and background refresh (calendar/meeting jobs) recovers too.

## What I will NOT do

- No application code changes — the code path is correct; only the stored secret is stale.
- I won't invent or generate the secret value; it must come from your Google Cloud Console so it matches the OAuth client.

## Optional follow-up

If you'd rather not manage your own Google credentials going forward, an alternative is switching the Gmail connect flow to a different credential source — but that's a larger change and out of scope for this fix. Say the word if you want to explore it separately.

When you approve, I'll open the secure secret form for `GOOGLE_OAUTH_CLIENT_SECRET`.
