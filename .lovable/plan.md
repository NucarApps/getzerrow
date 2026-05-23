# Email Pipeline — Operational Hardening (3 tracks)

Three independent improvements to the email pipeline. Each is surgical and can ship in one pass.

---

## Track 1 — Per-account health card + DLQ retry UI

Today there's no single place to see whether a connected Gmail account is healthy. Drift in `watch_expiration`, a stuck history, or a growing DLQ is invisible until the user notices missing mail.

**Add to Settings (under the existing Gmail accounts list):**

For each connected account, render a compact health card showing:
- Last successful poll (`gmail_accounts.last_poll_at`)
- Last webhook push received (latest `pubsub_events` row matching the account email)
- Watch expiry countdown (`watch_expiration` → "renews in 4h 12m" or red if expired)
- Pending jobs count (`message_jobs` where `user_id`, `status='pending'`)
- Running jobs count (`status='running'`)
- DLQ count (`status='dlq'`)
- Last error (most recent `last_error` from `message_jobs` in the past hour)

**DLQ retry action:**
- "Retry failed (N)" button on the card → calls a new server function `retryDlqJobs({ accountId })` that resets the user's `status='dlq'` rows back to `pending`, `attempt=0`, `next_run_at=now()`, `locked_at=null`, `last_error=null`.
- "Inspect" link opens a small drawer listing the DLQ rows (subject, from, last_error, attempts) with a per-row retry + delete.

**Technical notes:**
- New `getAccountHealth` server function (`requireSupabaseAuth`) returns a `{ accountId, lastPollAt, lastPushAt, watchExpiresAt, pending, running, dlq, lastError }[]` shape. Single round-trip: one CTE or 4 small queries via `supabase` (RLS-scoped).
- New `retryDlqJobs` and `deleteDlqJob` server functions, both `requireSupabaseAuth` + scoped to the caller's `user_id`.
- Auto-refresh the card every 15s via TanStack Query `refetchInterval`.
- No schema changes.

---

## Track 2 — Webhook authentication: validate Pub/Sub OIDC JWT

Today `gmail-webhook` only checks a shared `?token=GMAIL_WEBHOOK_TOKEN` query param. Anyone with that secret can forge pushes. Google's recommended scheme is to attach an OIDC bearer token signed by Google to each push, and to verify the JWT on receipt.

**Changes to `src/routes/api/public/gmail-webhook.ts`:**

1. Read `Authorization: Bearer <jwt>` header (Pub/Sub sets it when the subscription is configured with `pushConfig.oidcToken.serviceAccountEmail`).
2. Verify the JWT:
   - Fetch Google's public keys from `https://www.googleapis.com/oauth2/v3/certs` (cache in module scope for 1 hour).
   - Validate signature (RS256), `iss=https://accounts.google.com`, `aud=<expected audience>` (the webhook URL or a value we configure on the subscription), `exp > now`.
   - Optionally check `email` claim equals an allowlisted service account from a new `GMAIL_PUBSUB_SERVICE_ACCOUNT` secret.
3. Keep the existing `?token=` check as a **fallback** for one release so an old subscription doesn't break; log `push_legacy_auth` events when only the token matches. After the user reconfigures the subscription, we can remove it.
4. Test webhook (`x-zerrow-test: 1`) path stays unchanged.
5. Log `push_unauthorized` with reason: `no_jwt`, `bad_signature`, `bad_iss`, `bad_aud`, `expired`, `bad_email`.

**Tiny JWT verify helper** in `src/lib/google-jwt.server.ts` (no new deps — Web Crypto + `fetch`; the runtime is workerd-compatible). ~80 lines.

**Subscription reconfig (manual, one-time, user-facing instructions):** in the Settings panel, surface a "Webhook auth: OIDC pending" warning until the first verified OIDC push lands. Tell the user to set `pushConfig.oidcToken.serviceAccountEmail` on the Pub/Sub subscription in GCP Console.

**Secret needed:** `GMAIL_PUBSUB_SERVICE_ACCOUNT` (the service account email Pub/Sub will sign as). Optional — if unset, we accept any valid Google-issued JWT for the correct audience.

---

## Track 3 — Token refresh mutex + faster job reclaim

Two correctness fixes in the queue runtime.

**3a — Per-account refresh mutex in `getAccessToken`:**

Today, if N concurrent jobs run for the same account around expiry, each one independently calls `refreshAccessToken`, which:
- Wastes 3 round-trips to Google
- Risks rate limiting on the OAuth endpoint
- Races on the `update gmail_accounts` write — last writer wins, others' tokens become stale immediately

**Change `src/lib/google-oauth.server.ts`:**
- Add a module-level `Map<accountId, Promise<string>>` of in-flight refreshes.
- In `getAccessToken`, if expiry < 2min away AND a refresh promise already exists for this account, `await` the existing one instead of starting a new one.
- Delete the entry once the refresh resolves or rejects (in `finally`).
- Per-worker process scope is correct here — different Workers can each refresh once; the worry is intra-process stampedes.

**3b — Faster reclaim window in `claim_message_jobs`:**

Today `claim_message_jobs` ignores rows locked < 5 min ago. Worker job timeout is 25s. A truly stuck row sits idle for ~4.5 min. Reduce to 60s.

**Migration:**
```sql
CREATE OR REPLACE FUNCTION public.claim_message_jobs(p_limit int, p_priority int DEFAULT NULL)
RETURNS TABLE(...) -- unchanged signature
...
WHERE j.status <> 'dlq'
  AND j.next_run_at <= now()
  AND (j.locked_at IS NULL OR j.locked_at < now() - interval '60 seconds')
  AND (p_priority IS NULL OR j.priority = p_priority)
...
```

Risk: if a worker takes >60s on a single message (unlikely given the 25s timeout) a second worker could pick it up. Acceptable — `processGmailMessage` is idempotent (Gmail label-add is a no-op, `emails` write is `upsert` on `gmail_message_id`).

---

## Suggested rollout order

1. **Track 3** — smallest blast radius, immediate quality lift.
2. **Track 1** — gives us the visibility to verify Tracks 2 + 3 worked.
3. **Track 2** — needs a coordinated Pub/Sub subscription change in GCP, so ship the dual-auth window first and remove the legacy `?token=` check in a follow-up.

## Technical summary

- Files created: `src/lib/google-jwt.server.ts`, `src/lib/account-health.functions.ts`, `src/components/settings/AccountHealthCard.tsx`, `src/components/settings/DlqDrawer.tsx`.
- Files edited: `src/routes/api/public/gmail-webhook.ts`, `src/lib/google-oauth.server.ts`, `src/routes/_authenticated/settings.tsx`.
- Migration: 1 file — replaces `claim_message_jobs` with the 60s reclaim window.
- New secret (optional): `GMAIL_PUBSUB_SERVICE_ACCOUNT`.
- No schema changes; no breaking API changes.
- Verification: invoke each new server fn via the testing tool; force a token expiry to confirm only one refresh fires; send a Pub/Sub test push with and without a valid JWT; manually mark a job `dlq` and exercise the retry UI.
