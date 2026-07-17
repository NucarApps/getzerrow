
## Current state (verified)

Background sync **is** running.

- Cron job `google-contacts-sync-15m` is registered and **active** in pg_cron, schedule `*/15 * * * *` (every 15 minutes).
- It calls `POST /api/public/hooks/google-contacts-sync` with the cron secret.
- The hook loads every row in `google_sync_state` where `enabled = true`, then runs `runGoogleContactsSync(user_id, gmail_account_id)` for each — which respects the account's `sync_mode` (`pull_only` or `two_way`) and honors the 90s lease so a stuck run can't block the next tick.
- "Sync now" from the settings card still works on demand and is independent of the cron.

So: if the toggle is on, an account syncs at least every 15 minutes in the background, plus whenever you press Sync now.

## What "every 15 minutes" actually means

- Pull side: any new/edited Google contact shows up in Zerrow within ~15 minutes.
- Push side (two-way only): local edits push to Google within ~15 minutes.
- Google People API has no push webhook, so polling is the only option — 15 minutes is a good default for a personal address book (well under People API quotas, ~96 pull passes per account per day).

## Options

Pick one — I'll implement in build mode.

1. **Keep 15 minutes** (recommended default). No change.
2. **Speed it up to every 5 minutes** for all enabled accounts. Update the pg_cron schedule to `*/5 * * * *`. Roughly 3x the API calls; still safely inside People API quotas for normal use.
3. **Per-account cadence picker** in the Google Contacts settings card: Off / 5 min / 15 min / 60 min. Adds a `sync_interval_minutes` column to `google_sync_state`, and the hook skips accounts whose `last_synced_at` is newer than their interval. Cron itself still ticks every 5 min, but each account only actually runs on its own cadence.

## Also worth adding (optional, small)

- A visible "Last background sync" timestamp on the settings card so you can tell at a glance that the cron is firing (we already store `last_synced_at`; just need to render it next to the mode badge).
- If a background run fails, surface the last error inline on the card instead of only in logs.

Say which option (1, 2, or 3) and whether to include the "last sync" + error line, and I'll ship it.
