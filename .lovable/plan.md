
## What I found in the running system

1. **One of your two connected accounts has no refresh token.** `tpercoco@nucar.com` has `refresh_token_enc = NULL`. Every 6h the watch-renew cron fails for it with `"Gmail account is missing OAuth tokens — user needs to reauthorize"`. Its current watch expires 2026-05-28; after that it goes dark with no UI indication.
2. **The poll & reconcile crons are silently dead.** `cron.job` shows `gmail-poll-2m` and `gmail-reconcile-15m` active, but `pubsub_events` has no `poll` row since 2026-05-23 and only one `reconcile` row in 48h. The pg_cron → pg_net hop is failing without surfacing. So when Pub/Sub blips, nothing catches up.
3. **All real pushes still use the legacy `?token=` query auth** (1073 in 24h, 0 OIDC). The OIDC code path exists but the Pub/Sub subscription was never migrated.
4. **Self-heal can't escalate.** When the 2h push-silence trigger fires, it calls `ensureWatch` → `getAccessToken`, which throws for any account without a refresh token. The error is logged to console and the account stays broken forever.
5. **Watch renewal has one runner, no second line of defense.** Every 6h, renew if <2 days remaining. Two consecutive misses (now plausible — see #2) can lapse a watch.

## Goal

Push, poll, and reconcile each become independently sufficient to keep the inbox in sync; when any of them breaks, the user sees it before mail goes missing.

## Plan

### 1. Diagnose & surface cron failures (root cause for #2)

- Add `src/routes/api/public/gmail-cron-healthcheck.ts` (CRON_SECRET gated) that returns last successful run time for each cron path from `pubsub_events`.
- Query `cron.job_run_details` + `net.http_response` in a one-off read to confirm whether pg_cron is firing and pg_net is reaching our Worker. Capture findings in `pubsub_events` as `cron_diag` rows.
- Likely fix: the `private.cron_post(path)` helper silently swallows non-2xx pg_net responses. Update it to insert a `pubsub_events` row tagged `event_type='cron_post'` with status + path so every scheduled tick leaves a trace, regardless of whether the endpoint inserted its own row.
- Add a `gmail-cron-watchdog` cron (every 10 min) that inserts a `cron_silent` event when expected cron paths haven't logged in N× their interval, so AccountHealthCard can show "polling stalled".

### 2. Detect dead OAuth and surface it (root cause for #1)

- Add `gmail_accounts.needs_reconnect boolean default false` + `last_oauth_error text`.
- In `getAccessToken`, when the refresh fails with `invalid_grant` / `unauthorized_client`, or when `refresh_token_enc IS NULL`, set `needs_reconnect=true` + record the error. Skip any further Gmail API calls for that account until cleared.
- `ensureWatch`, `syncSinceHistory`, the poll loop, and the renew cron all short-circuit on `needs_reconnect=true` instead of throwing.
- `AccountHealthCard` shows a red "Reconnect Gmail" banner with a one-click re-OAuth link when the flag is set. Reconnection clears the flag.

### 3. Guarantee Google always issues a refresh token

- In `src/lib/google-oauth.server.ts` (or wherever the OAuth start URL is built), always include `access_type=offline` AND `prompt=consent`. Without `prompt=consent`, repeat consents from the same Google account don't return a refresh token — which is exactly how tpercoco ended up with NULL.
- Add a post-callback assertion: if Google returns no `refresh_token`, do NOT overwrite an existing encrypted one, and if there isn't one yet, redirect back to the consent step with `prompt=consent` so we never store an account that can't be auto-renewed.

### 4. Tighten watch renewal so a missed cron can't lapse a watch

- Renewal cron from `0 */6 * * *` → `*/30 * * * *` (cheap: it only POSTs `/watch` when <3 days remain).
- Renewal threshold from "<2 days" → "<3 days remaining" (already on the way; align everywhere).
- Opportunistic top-up: on every successful Pub/Sub webhook, if `watch_expiration < now()+72h`, re-arm inline. Watches are otherwise renewed only by cron, which is exactly when cron breaks.

### 5. Push pipeline: finish OIDC migration, retire `?token=`

- Document the one-time GCP step: switch the Pub/Sub subscription's `pushConfig` to use `oidcToken` with the service account that already verifies (`GMAIL_PUBSUB_SERVICE_ACCOUNT`). Until that's done, keep the legacy fallback but log a `push_legacy_auth` row (already done) and add a Settings banner counting them.
- Once `push_legacy_auth` count drops to zero for 24h, remove the legacy fallback branch from `gmail-webhook.ts`.

### 6. Make poll & reconcile self-sufficient when push is degraded

- `gmail-poll`: in addition to the per-account 2h silence self-heal, escalate after 3 consecutive silent ticks to a `watch_renew_force` (re-call `/watch` even if expiration looks fine). Records `force_rearm` event.
- `gmail-reconcile`: on `listHistory` returning 404 ("history too old"), trigger `backfillRecent(30d)` automatically instead of failing — covers the case where both push and poll were down past Gmail's 7-day history TTL.

### 7. Observability on AccountHealthCard

Per-account row shows:
- last push, last poll, watch expiry, refresh-token presence, `needs_reconnect`, DLQ count, last error.
- A "Run diagnostic" button calling a new `runAccountDiagnostic` server fn that: verifies the OAuth token, calls `users.getProfile`, checks `watch_expiration`, optionally re-arms, and returns a structured report.

### Out of scope

- Backfill / classification logic changes.
- UI redesign beyond the AccountHealthCard banner additions.
- Touching the `message_jobs` queue / DLQ behavior (current state: only 2 DLQ rows, healthy).

## Files I expect to touch

- `supabase/migrations/<new>.sql` — `needs_reconnect`, `last_oauth_error` columns; update `private.cron_post` to log; new `gmail-cron-watchdog` schedule; tighten `gmail-renew-watches` schedule.
- `src/lib/google-oauth.server.ts` — `prompt=consent`, refresh-token assertion, mark `needs_reconnect`.
- `src/lib/gmail.server.ts` — `ensureWatch` short-circuit + threshold; opportunistic top-up helper.
- `src/routes/api/public/gmail-webhook.ts` — opportunistic watch top-up; track legacy auth count.
- `src/routes/api/public/gmail-poll.ts` — consecutive-silent escalation; respect `needs_reconnect`.
- `src/routes/api/public/gmail-reconcile.ts` — auto-backfill on "history too old".
- `src/routes/api/public/gmail-renew-watches.ts` — respect `needs_reconnect`; align threshold.
- `src/routes/api/public/gmail-cron-healthcheck.ts` (new).
- `src/components/settings/AccountHealthCard.tsx` — `needs_reconnect` banner, diagnostic button, cron-silence indicator.
- `src/lib/account-health.functions.ts` — expose new fields + `runAccountDiagnostic`.

## Risks

- `prompt=consent` adds one extra screen for users re-connecting an already-authorized Google account. Acceptable cost for guaranteed refresh tokens.
- More frequent renewal cron = ~48 extra POSTs/day per connected account against `/users/me/watch` — well within Gmail quotas.
- Tightening cron schedules without first fixing the silent-failure root cause just multiplies the silence. That's why step 1 must land before step 4.

## Suggested execution order

1, 2, 3 → land first (stops the bleeding for tpercoco and reveals why poll is silent).
4, 6 → tighten the redundancy layers.
5 → finish OIDC migration once the rest is stable.
7 → user-visible observability throughout.
