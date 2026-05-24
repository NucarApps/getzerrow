## What I found

The Gmail push/webhook side is working: new push events are being received and message jobs are being created.

The scheduled cron side is still failing: recent cron HTTP calls are returning `401 Unauthorized`, so the queue only drains when you manually click **Drain queue now**.

## Important clarification

You do **not** need to set this cron in Google Cloud. The app already has database-managed scheduled jobs configured. Adding the same schedule in Google Cloud can create duplicate calls and make debugging harder.

## Plan

1. **Confirm which cron caller is failing**
   - Inspect the database-managed cron responses and commands.
   - Check whether the `401` responses come from the app’s built-in scheduled jobs or any external Google Cloud scheduler calls.

2. **Make the app’s scheduled jobs self-contained**
   - Update the cron auth flow so the database-managed jobs and the app server use the same secret source.
   - Keep the stricter security behavior: public endpoints must still reject unauthenticated calls.

3. **Reschedule cron jobs if needed**
   - Ensure all Gmail processing jobs call the correct production URL.
   - Ensure every job sends the accepted auth header.
   - Remove or replace any remaining legacy `apikey`-only cron configuration.

4. **Verify the fix**
   - Watch fresh cron responses until they return `200` instead of `401`.
   - Confirm `message_jobs` pending rows drain without pressing **Drain queue now**.
   - Confirm the sync activity panel stops showing processing delays.

## What you should do in Google Cloud

After this is fixed, disable the duplicate Google Cloud cron/scheduler entry for this same sync endpoint. The built-in scheduler should be the source of truth.