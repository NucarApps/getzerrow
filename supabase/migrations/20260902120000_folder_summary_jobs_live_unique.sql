-- One live digest job per schedule.
--
-- enqueueFolderSummaryJob inserted unconditionally, so a double-click on
-- "Run now" -- or a cron tick landing on top of a manual run -- queued two
-- identical jobs and the user got the same digest twice. The enqueue now
-- checks for a live job first, but a check-then-insert leaves a race window
-- open; this index closes it, so the loser gets 23505 and reports the job
-- that did land instead of sending a duplicate.
--
-- Partial on the two statuses that mean "still on its way out": queued, or
-- claimed by the worker but not yet finished. Finished rows (done/failed)
-- are history and may pile up per schedule.

-- Collapse any duplicates that predate the index, keeping the oldest of each
-- schedule's live jobs -- the one the worker would have claimed first.
UPDATE public.folder_summary_jobs j
   SET status = 'failed',
       error = 'Superseded by an earlier queued run of the same digest',
       finished_at = COALESCE(j.finished_at, now()),
       updated_at = now()
 WHERE j.status IN ('pending', 'running')
   AND EXISTS (
     SELECT 1
       FROM public.folder_summary_jobs o
      WHERE o.schedule_id = j.schedule_id
        AND o.status IN ('pending', 'running')
        AND (o.created_at, o.id) < (j.created_at, j.id)
   );

CREATE UNIQUE INDEX IF NOT EXISTS folder_summary_jobs_live_per_schedule_key
  ON public.folder_summary_jobs (schedule_id)
  WHERE status IN ('pending', 'running');
