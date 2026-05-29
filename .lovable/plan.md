# CASA Tier 2 Remediation Plan

Goal: close the gaps a CASA Tier 2 lab will flag so the Google OAuth restricted-scope review passes. Three workstreams.

## 1. HTTP security headers (the main gap)

`src/server.ts` currently returns responses with no security headers. The scan/lab expects a standard hardened set. We will add a single helper that decorates every outgoing response (success and error paths) with:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Content-Security-Policy` — a policy tuned for this app so nothing breaks:
  - `default-src 'self'`
  - `script-src 'self' 'unsafe-inline'` (TanStack SSR injects inline hydration scripts; `'unsafe-eval'` only if a runtime error shows it's needed)
  - `style-src 'self' 'unsafe-inline'` + `https://fonts.googleapis.com`
  - `font-src 'self' https://fonts.gstatic.com`
  - `img-src 'self' data: https:` (logos/avatars are fetched from arbitrary company domains)
  - `connect-src 'self'` + the Supabase URL + `https://oauth.lovable.app` + Lovable AI/realtime (wss) origins
  - `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self' https://accounts.google.com`

Implementation detail: wrap the existing `fetch` flow in `server.ts` so the header set is applied to both `normalizeCatastrophicSsrResponse(...)` output and `brandedErrorResponse()`. Headers are merged onto a cloned response so existing `content-type`/redirect headers are preserved.

Verification: load the app in preview, confirm no CSP violations in the console (inbox, settings, login, OAuth round-trip, contact card `/c/$handle`, logo fetching). Adjust `connect-src`/`img-src` if any legitimate request is blocked, then re-test.

## 2. Complete the account-deletion cascade

`deleteAccount` in `src/lib/account.functions.ts` deletes most per-user tables, but two tables that hold user-derived data are missed, so PII survives a "delete my account" request — a Tier 2 failure.

- `email_search_index` — has a `user_id` column and stores a tsvector built from the user's email text. No foreign key to `emails`, so it is NOT cleaned up when emails are deleted. Add it to the deletion list (delete by `user_id`).
- `pubsub_events` — has no `user_id`, but stores the user's Gmail `email_address` in raw push-notification logs. Before deleting `gmail_accounts`, collect the connected `email_address` values, then delete `pubsub_events` rows matching those addresses.

Changes (all inside the existing `deleteAccount` handler, admin client):
1. Select `id` AND `email_address` from `gmail_accounts` up front (already selects `id`).
2. Add `email_search_index` to the `tables` array (delete by `user_id`).
3. After the loop, delete `pubsub_events` where `email_address` is in the collected list (skip if no addresses). Log failures via `logError`, consistent with existing behavior.

Verification: type-check passes; manually trace that every public table with user data is now covered (cross-checked against the live table list).

## 3. Privacy policy — verify Limited Use disclosure

Good news: `src/routes/privacy.tsx` already contains a dedicated "Limited Use of Google user data" section with the required verbatim clause linking the Google API Services User Data Policy, plus encryption, retention, and deletion sections. This gap is effectively already closed.

Minor polish only (optional, low risk):
- In "Retention & deletion", add one line that deletion also clears the search index and push-notification logs, so the policy matches the cascade fix in step 2.

No structural rewrite needed.

## Out of scope / already passing

These were confirmed already in place and need no work: column-level pgcrypto AEAD encryption of tokens/bodies/PII, RLS scoped to `auth.uid()`, `requireSupabaseAuth` on server functions, Zod input validation, and `CRON_SECRET`/`GMAIL_WEBHOOK_TOKEN` protection on `/api/public/*` mutating endpoints.

## Files touched

- `src/server.ts` — add security-header helper, apply to all responses.
- `src/lib/account.functions.ts` — add `email_search_index` + `pubsub_events` to deletion.
- `src/routes/privacy.tsx` — one-line retention wording update (optional).

## Final verification

- Build/type-check clean (0 errors).
- Preview smoke test with console open: no CSP breakage across inbox, settings, login, OAuth, contact card, logo fetch.
- Confirm header set present on a response (network panel).
