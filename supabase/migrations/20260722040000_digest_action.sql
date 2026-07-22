-- Digest action (rules upgrade, task 9): folders can collect routed
-- mail into a daily/weekly digest email instead of interrupting.
--
-- digest_items holds only references (email_id) — no email content is
-- duplicated, so nothing new needs encryption. The hourly sender joins
-- back to emails through the existing decrypt path.

CREATE TABLE public.digest_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email_id uuid REFERENCES public.emails(id) ON DELETE CASCADE,
  bucket text NOT NULL CHECK (bucket IN ('daily', 'weekly')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX digest_items_pending_idx
  ON public.digest_items (user_id, bucket)
  WHERE sent_at IS NULL;

ALTER TABLE public.digest_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY digest_items_owner ON public.digest_items
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

GRANT SELECT, DELETE ON public.digest_items TO authenticated;
GRANT ALL ON public.digest_items TO service_role;

-- Per-user digest schedule. No user_settings table existed, so this
-- creates it minimally; other settings can join later (additive).
CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  digest_hour integer NOT NULL DEFAULT 8 CHECK (digest_hour >= 0 AND digest_hour <= 23),
  digest_timezone text NOT NULL DEFAULT 'UTC' CHECK (length(digest_timezone) <= 64),
  -- Weekly digests send on this local weekday (0=Sunday … 6=Saturday).
  digest_weekly_dow integer NOT NULL DEFAULT 1 CHECK (digest_weekly_dow >= 0 AND digest_weekly_dow <= 6),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_settings_owner ON public.user_settings
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE ON public.user_settings TO authenticated;
GRANT ALL ON public.user_settings TO service_role;

-- Hourly digest tick (minute 7, off the :00 stampede).
DO $$ BEGIN
  PERFORM cron.unschedule('send-digest-hourly');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'send-digest-hourly',
  '7 * * * *',
  $$ SELECT private.cron_post('/api/public/hooks/send-digest'); $$
);
