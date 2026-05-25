# Reconnect Gmail + surface "reconnect required" in the UI

## Root cause

The earlier security migration dropped the plaintext `access_token` /
`refresh_token` columns on `gmail_accounts`. Both Gmail accounts in the
project still had tokens only in those plaintext columns — they were never
migrated to `access_token_enc` / `refresh_token_enc`. Current state:

- `tpercoco@nucar.com` — no access token, no refresh token
- `chris@nucar.com` — access token only (expires within the hour), no
  refresh token

`getAccessToken` in `src/lib/google-oauth.server.ts` requires both tokens
and throws `"Gmail account is missing OAuth tokens — user needs to
reauthorize"` on every call. `searchGmailAndIngest` catches that per
account and continues silently, so the UI sees `found: 0, ingested: 0`
and we wrongly look like Gmail itself returned nothing. Background sync
is failing for the same reason, which is why the local DB has no
`Bill_Baker@reyrey.com` rows either.

This is not a search-logic bug — `from:Bill_Baker@reyrey.com` parses and
runs correctly. The connection just can't talk to Gmail.

## Action required from you

Reconnect Gmail for both accounts:

1. Open **Settings → Gmail accounts**
2. Disconnect each account, then reconnect via Google OAuth
3. Make sure Google's consent screen shows up (the OAuth flow forces
   `prompt=consent` so a fresh refresh token is issued)

After that, run the search again — `from:Bill_Baker@reyrey.com` will go
out to Gmail and pull matches in.

## Optional code change (for clarity next time)

To stop hiding this failure mode, update `searchGmailAndIngest` in
`src/lib/gmail.functions.ts` so that when every account fails with a
"missing OAuth tokens" / "reauthorize" error, it returns
`{ ingested: 0, found: 0, reason: "reauth_required" }` instead of a
generic zero. Then in `src/routes/_authenticated/inbox.tsx`, show a
clear "Gmail needs to be reconnected — go to Settings" banner when
`lastGmailResult.reason === "reauth_required"` instead of the current
silent empty state.

No DB migrations, no changes to the search parser, no changes to the
operator-aware query path.

## Files

- `src/lib/gmail.functions.ts` — detect reauth errors in the per-account
  catch and propagate a `reason: "reauth_required"` when all accounts
  failed that way.
- `src/routes/_authenticated/inbox.tsx` — show a reconnect-Gmail banner
  for that reason.

## Out of scope

- Auto-migrating tokens (impossible — there are no plaintext tokens left
  to migrate; the columns were dropped).
- Changing how `getAccessToken` validates tokens (current check is
  correct).
