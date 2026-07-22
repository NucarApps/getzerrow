-- Rules upgrade, task 7: AI-derived sender categories.
--
-- contact_groups.kind distinguishes how a group came to exist:
--   * 'manual'      — created by the user (default, all existing rows),
--   * 'ai_category' — created by the nightly categorize-senders cron from
--                     AI-inferred sender kinds (recruiter/vendor/…),
--   * 'imported'    — created by an import (Google sync, CSV, …).
--
-- Additive only: no rows change behavior — the sender_in_group filter op
-- already matches against ALL of a sender's groups, so AI-derived groups
-- become usable in folder rules the moment they gain members.
ALTER TABLE public.contact_groups
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'manual'
  CHECK (kind IN ('manual', 'ai_category', 'imported'));

-- Nightly sender categorization: 03:17 UTC (off the :00 stampede).
DO $$ BEGIN
  PERFORM cron.unschedule('categorize-senders-nightly');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'categorize-senders-nightly',
  '17 3 * * *',
  $$ SELECT private.cron_post('/api/public/hooks/categorize-senders'); $$
);
