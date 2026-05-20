# Pub/Sub event viewer in Settings

Add a new section to `/settings` that shows recent rows from the `pubsub_events` table so you can see, in real time, whether Gmail push notifications are arriving and what they contain.

## What you'll see

A card titled **"Gmail Pub/Sub activity"** under the existing settings sections, with:

- **Live counters** for the last 24h: total push events, accounts matched (sum), emails synced (sum), errors.
- **Last event received** timestamp + "Xs ago" so it's obvious when pushes go quiet.
- **Refresh** button + auto-refresh every 10s.
- **Raw event log table** — most recent 100 rows of `pubsub_events`:
  - Received at (with relative time)
  - Event type (`push`, `watch_renew`, etc.)
  - Email address
  - History ID
  - Accounts matched
  - Synced count
  - Error (red, truncated; expandable on click)
- **Row expansion**: clicking a row reveals the full raw JSON of that record so nothing is hidden.
- **Filter chips**: All / Push only / Errors only / Watch renewals.

## How it's wired

1. New server function `listPubsubEvents` in `src/lib/gmail.functions.ts`:
   - Protected with `requireSupabaseAuth`.
   - Uses `supabaseAdmin` to read `pubsub_events` (table has no RLS — admin-only access is correct since we restrict by gating server fn to logged-in users only and the table contains no PII beyond Gmail address).
   - Optional filter for `event_type` and `only_errors`.
   - Returns latest 100 rows + aggregate counts for last 24h.
2. New component `src/components/settings/PubsubActivity.tsx` rendering the card described above. Uses TanStack Query with `refetchInterval: 10000`.
3. Mount it in `src/routes/_authenticated/settings.tsx` below the existing Inbox Overrides card.

## What it does NOT change
- No schema changes — `pubsub_events` already exists with all the columns we need.
- No change to the webhook handler or sync logic.
- No new secrets.

After this lands, when an email shows up in Gmail but not in the app, you can open Settings, see whether a `push` event arrived for that history_id, how many accounts matched, how many emails synced, and any error string — making it clear whether the gap is on the Pub/Sub side or in our processing.
