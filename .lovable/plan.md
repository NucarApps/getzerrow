## What I found

- The backfill job itself is healthy: it still has a saved Gmail `next_page_token`, so it can resume.
- The cron jobs are firing, but they call the stable Lovable URL, which returns a `302` redirect to `getzerrow.com`.
- `pg_net` does not follow that redirect, so the endpoint never actually runs from cron.
- I manually called the custom-domain endpoint directly, and the job immediately moved from `1,000` to `3,000` found, confirming the backfill logic works.
- There are also two duplicate backfill cron schedules; both should be cleaned up.

## Plan

1. Update the cron base URL
   - Change `private.cron_settings.base_url` to `https://getzerrow.com` so scheduled calls hit the endpoint directly with no redirect.

2. Remove duplicate backfill schedules
   - Unschedule both existing backfill cron entries.
   - Create one clean `gmail-backfill-tick` schedule every minute.
   - Keep the `?limit=4` parameter so multiple accounts can progress per minute.

3. Kick the stuck job once immediately
   - After fixing the schedule, call the endpoint once so Tony’s existing job continues right away instead of waiting for the next minute.

4. Verify
   - Confirm the active job’s `total_found` increases beyond `3,000` on the next tick.
   - Confirm only one `gmail-backfill-tick` schedule remains.
   - Confirm cron calls return successful responses instead of redirect-only responses.

## Technical details

This is a database data/config correction, not an app code issue. I’ll use a direct backend data update for `private.cron_settings` and `cron` schedule rows, not edit source files.