## Problem

Chris's inbox shows 12 unread but doesn't auto-update. Database confirms:
- Push sync is healthy — 9 new emails inserted in the last hour, last push 30s before the report, `accounts_matched=1`, `synced_count>0` on every tick.
- Inserted rows have `INBOX` in `raw_labels` and `gmail_account_id` set, so they SHOULD match `rowBelongsInList` for the `["emails", accountId, "all", ...]` query key.

So data is arriving in Postgres but not reaching the open browser tab. The bug is in how `useEmailRealtime` manages the websocket lifecycle, not in the filter or the backend.

## Root causes

**1. Realtime auth token never refreshes (primary).** `useEmailRealtime` calls `supabase.realtime.setAuth(access_token)` once at connect time and only reconnects on `SIGNED_IN`/`SIGNED_OUT`. Supabase Auth rotates the JWT every ~1 hour via `TOKEN_REFRESHED`, which we ignore. After the first refresh, the realtime server keeps the socket open but RLS-filtered `postgres_changes` events stop flowing for that user. Symptom matches exactly: works for a while after page load, then silently stops.

**2. No reconnect on channel errors.** `.subscribe()` is fire-and-forget. If the channel reports `CHANNEL_ERROR`, `TIMED_OUT`, or `CLOSED` (network blip, server restart, Cloudflare idle timeout), we never rejoin. Tab visibility-change is the only recovery path today.

**3. Polling fallback is slow.** The inbox `useQuery` has `refetchInterval: 30_000`, so even when realtime is broken, new mail takes up to 30s — and the user reads that as "not auto-updating." We can tighten this without hammering the DB.

## Plan

### 1. Fix realtime auth lifecycle (`src/lib/use-email-realtime.ts`)
- Listen for `TOKEN_REFRESHED` in addition to `SIGNED_IN`/`SIGNED_OUT`. On refresh, call `supabase.realtime.setAuth(session.access_token)` without tearing down the channel (cheaper and avoids a flicker).
- On the initial connect, also subscribe to subsequent token refreshes the same way.

### 2. Reconnect on channel errors
- Inspect the `status` argument of `.subscribe((status, err) => …)`. On `CHANNEL_ERROR`, `TIMED_OUT`, or `CLOSED`, tear down and reconnect with a short backoff (1s → 2s → 5s, capped).
- On successful `SUBSCRIBED`, invalidate `["emails"]` once so the UI catches anything missed during the gap.

### 3. Tighten polling fallback (`src/routes/_authenticated/inbox.tsx`)
- Change `refetchInterval` on the inbox `useQuery` from `30_000` to `15_000`. Keep `refetchOnWindowFocus: true`. This guarantees a worst-case 15s lag even if realtime is fully down, and the query is already paginated/limited so cost is minimal.

### Out of scope
- Backend push/poll/reconcile (already healthy per `pubsub_events`).
- `rowBelongsInList` filter logic (rewritten last turn; the data confirms inserts would match).
- Folder counts/badges — same realtime channel feeds them once events flow again.

## Files touched
- `src/lib/use-email-realtime.ts` — token-refresh re-auth, channel-status reconnect with backoff, post-reconnect invalidate.
- `src/routes/_authenticated/inbox.tsx` — `refetchInterval: 15_000`.

## Verification
- Open inbox, leave tab focused for >1 hour, send a test email from another account, confirm it appears within seconds (validates token-refresh fix).
- In DevTools, kill the websocket connection; confirm the hook logs a reconnect and the next inserted email shows up.
- Confirm worst-case 15s polling catches new mail even with realtime disabled.
