-- Retire the encryption-backfill cron.
--
-- The four RPCs it drives (backfill_emails_encryption, backfill_contacts_
-- encryption, backfill_reply_drafts_encryption, backfill_folder_examples_
-- encryption) were dropped in 20260528105923 once the at-rest encryption
-- rollout finished. The cron kept firing nightly and logging four PGRST202
-- "Could not find the function ... in the schema cache" errors into
-- pubsub_events, which feeds the account-health UI — pure noise that
-- desensitizes a real signal.
--
-- The job was scheduled outside migrations (Supabase dashboard), so unschedule
-- it by command match rather than by a name we can only guess at. The matching
-- route handler is deleted in the same change.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT jobname FROM cron.job WHERE command ILIKE '%encryption-backfill%'
  LOOP
    PERFORM cron.unschedule(rec.jobname);
    INSERT INTO public.pubsub_events (event_type, details)
    VALUES ('migration', 'unscheduled dead cron job: ' || rec.jobname);
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  -- Never block the migration on cron introspection permissions.
  INSERT INTO public.pubsub_events (event_type, details, error)
  VALUES ('migration', 'encryption-backfill unschedule skipped', SQLERRM);
END $$;
