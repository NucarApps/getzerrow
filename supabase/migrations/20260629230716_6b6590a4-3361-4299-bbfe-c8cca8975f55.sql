-- Speed up the live processing lane.
--
-- The live lane drains brand-new mail server-side every 5s, independent of any
-- browser session. Previously it fired a single request with limit=50. Under a
-- burst (e.g. a sync/backfill enqueuing many priority=0 jobs) one worker pass
-- couldn't keep up, so mail trickled in after the inbox was already open.
--
-- This raises the per-pass batch to 100 and fans out to 3 parallel requests
-- per tick. Job claiming uses FOR UPDATE SKIP LOCKED, so the parallel workers
-- divide the queue instead of double-processing. Combined with the larger app
-- worker concurrency (JOB_WORKER_CONCURRENCY=32) and batched AI classification,
-- bursts now clear far faster.
DO $$ BEGIN PERFORM cron.unschedule('gmail-process-live-5s'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule(
  'gmail-process-live-5s',
  '5 seconds',
  $$
    SELECT private.cron_post('/api/public/gmail-process-jobs?limit=100&priority=0');
    SELECT private.cron_post('/api/public/gmail-process-jobs?limit=100&priority=0');
    SELECT private.cron_post('/api/public/gmail-process-jobs?limit=100&priority=0');
  $$
);