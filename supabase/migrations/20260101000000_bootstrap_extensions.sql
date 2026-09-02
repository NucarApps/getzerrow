-- Bootstrap extensions and cron placeholders used by later migrations.
--
-- Timestamped before every other migration on purpose: the first
-- `cron.schedule(...)` call (20260520174513) predates the migration that
-- creates pg_cron (20260521190714), so a fresh `supabase db reset` failed
-- with `schema "cron" does not exist` and the DB-backed integration suite
-- never ran in CI. Every statement here is idempotent, so applying this on a
-- database that already has the extensions is a no-op.
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto with schema extensions;

-- Several migrations ALTER or UNSCHEDULE a cron job by name that no
-- migration ever SCHEDULES — those jobs were created by hand in the
-- dashboard. Replaying the history against an empty database therefore
-- died on `job_id can not be NULL`, so no environment could be built from
-- scratch. Create a dormant placeholder for each such name, which the
-- later migrations then alter or unschedule as they were written to.
--
-- Safe on production by construction: every one of these names must already
-- exist there (the migrations that reference them succeeded), so the
-- IF NOT EXISTS guard means nothing is created. Where a placeholder IS
-- created it is inert — it runs `SELECT 1` once a year on Feb 29.
do $$
declare
  v_name text;
  v_names text[] := array[
    'audit-encryption-leaks',
    'categorize-senders-nightly',
    'check-folder-retry-alerts-5m',
    'check-folder-write-alerts-5m',
    'contact-enrich-enqueue-15m',
    'contact-enrich-jobs-2m',
    'cron-dispatch-reap',
    'cron-watchdog',
    'gmail-backfill-tick',
    'gmail-poll',
    'gmail-poll-2m',
    'gmail-poll-fallback',
    'gmail-process-jobs-30s',
    'gmail-process-live-5s',
    'gmail-reconcile-15m',
    'gmail-reconcile-5m',
    'gmail-renew-watches',
    'gmail-renew-watches-daily',
    'gmail-rescue-classify-10m',
    'gmail-search-reindex-1m',
    'google-contacts-sync-15m',
    'reconcile-meetings-1m',
    'relearn-folders-hourly',
    'run-folder-summaries-every-5min',
    'run-scheduled-actions-1m',
    'schedule-meeting-bots-2m',
    'send-digest-hourly',
    null
  ];
begin
  foreach v_name in array v_names loop
    if v_name is null then
      continue;
    end if;
    if not exists (select 1 from cron.job where jobname = v_name) then
      perform cron.schedule(v_name, '0 0 29 2 *', 'select 1');
    end if;
  end loop;
end $$;
