-- Backfill Tony Percoco's Factory-Nissan domain rule and reclassify stuck emails.
-- This corrects historical data only; going-forward auto-routing is handled
-- by the new bulkMoveEmails create_rule path plus searchGmailAndIngest filter
-- application in code.

DO $$
DECLARE
  v_user_id uuid := '0df372d7-33d1-41c0-98f7-eb0b87bf6557';
  v_folder_id uuid := '3282bd2b-d75e-404d-b597-d18ce5afaf1d';
  v_domain text := 'nissan-usa.com';
BEGIN
  -- Idempotent: only insert the filter row if it does not already exist.
  IF NOT EXISTS (
    SELECT 1 FROM public.folder_filters
    WHERE folder_id = v_folder_id
      AND field = 'domain'
      AND op = 'contains'
      AND value = v_domain
  ) THEN
    INSERT INTO public.folder_filters (folder_id, field, op, value)
    VALUES (v_folder_id, 'domain', 'contains', v_domain);
  END IF;

  -- Reclassify the stuck nissan-usa.com rows into the folder.
  UPDATE public.emails
  SET folder_id = v_folder_id,
      classified_by = 'domain_rule',
      ai_confidence = 1,
      classification_reason = 'Domain rule: ' || v_domain || ' → Factory-Nissan',
      is_archived = true
  WHERE user_id = v_user_id
    AND folder_id IS NULL
    AND from_addr ILIKE '%@' || v_domain || '%';
END $$;