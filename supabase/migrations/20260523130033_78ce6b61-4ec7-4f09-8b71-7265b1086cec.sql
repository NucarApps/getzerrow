
-- Remove duplicate cron jobs
DO $$
BEGIN
  BEGIN PERFORM cron.unschedule('gmail-poll-fallback'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM cron.unschedule('gmail-renew-watches-daily'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM cron.unschedule('run-folder-summaries-every-5min'); EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

-- Rewrite gmail-process-jobs-30s to use private.cron_post (no embedded keys/URLs)
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'gmail-process-jobs-30s'),
  command := $cmd$
    SELECT private.cron_post('/api/public/gmail-process-jobs?limit=100');
    SELECT private.cron_post('/api/public/gmail-process-jobs?limit=100');
    SELECT private.cron_post('/api/public/gmail-process-jobs?limit=100');
    SELECT private.cron_post('/api/public/gmail-process-jobs?limit=100');
  $cmd$
);
