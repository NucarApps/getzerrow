UPDATE public.message_jobs
SET status = 'pending', locked_at = NULL, next_run_at = now(), last_error = 'manually reset from stuck running'
WHERE id = 'f6e18c37-32bb-468d-aff8-a50263e2eda5' AND status = 'running';