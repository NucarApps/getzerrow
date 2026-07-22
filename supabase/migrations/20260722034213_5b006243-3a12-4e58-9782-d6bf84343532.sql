-- Rules-engine action fan-out foundation (rules upgrade, task 4).
CREATE TABLE public.folder_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id uuid NOT NULL REFERENCES public.folders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action_type text NOT NULL CHECK (action_type IN (
    'archive', 'label', 'reply', 'send_email', 'forward', 'draft',
    'mark_spam', 'delete', 'call_webhook', 'notify_channel', 'digest',
    'mark_read', 'star', 'move_folder'
  )),
  label_id text,
  move_to_folder_id uuid REFERENCES public.folders(id) ON DELETE CASCADE,
  subject_template text,
  body_template_enc bytea,
  to_addr text,
  cc_addr text,
  bcc_addr text,
  webhook_url text,
  webhook_secret_enc bytea,
  channel_id uuid,
  digest_bucket text CHECK (digest_bucket IN ('daily', 'weekly') OR digest_bucket IS NULL),
  delay_minutes integer NOT NULL DEFAULT 0 CHECK (delay_minutes >= 0 AND delay_minutes <= 1440),
  static_attachments jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX folder_actions_folder_idx ON public.folder_actions (folder_id) WHERE enabled;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.folder_actions TO authenticated;
GRANT ALL ON public.folder_actions TO service_role;
ALTER TABLE public.folder_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users access own folder actions" ON public.folder_actions
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.folders f WHERE f.id = folder_id AND f.user_id = auth.uid())
  );

CREATE TABLE public.scheduled_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_action_id uuid REFERENCES public.folder_actions(id) ON DELETE CASCADE,
  email_id uuid REFERENCES public.emails(id) ON DELETE CASCADE,
  run_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'error', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0,
  last_error text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_actions_due_idx ON public.scheduled_actions (run_at) WHERE status = 'pending';
CREATE INDEX scheduled_actions_user_idx ON public.scheduled_actions (user_id, created_at DESC);
GRANT SELECT, UPDATE ON public.scheduled_actions TO authenticated;
GRANT ALL ON public.scheduled_actions TO service_role;
ALTER TABLE public.scheduled_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own scheduled actions" ON public.scheduled_actions
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users cancel own scheduled actions" ON public.scheduled_actions
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Task 5: webhook delivery
ALTER TABLE public.folder_actions
  ADD COLUMN IF NOT EXISTS include_body boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.set_folder_action_webhook(
  p_action_id uuid, p_user_id uuid, p_url text, p_secret text, p_key text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions' AS $$
DECLARE v_updated integer;
BEGIN
  UPDATE public.folder_actions
     SET webhook_url = p_url, webhook_secret_enc = private.encrypt_text(p_secret, p_key)
   WHERE id = p_action_id AND user_id = p_user_id AND action_type = 'call_webhook';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END; $$;
REVOKE EXECUTE ON FUNCTION public.set_folder_action_webhook(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_folder_action_webhook(uuid, uuid, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_folder_action_webhook(p_action_id uuid, p_key text)
RETURNS TABLE(webhook_url text, webhook_secret text, include_body boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions' AS $$
  SELECT fa.webhook_url, private.decrypt_text(fa.webhook_secret_enc, p_key), fa.include_body
  FROM public.folder_actions fa WHERE fa.id = p_action_id;
$$;
REVOKE EXECUTE ON FUNCTION public.get_folder_action_webhook(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_folder_action_webhook(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_scheduled_actions(p_limit integer DEFAULT 20)
RETURNS TABLE(id uuid, user_id uuid, folder_action_id uuid, email_id uuid, attempt integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT s.id FROM public.scheduled_actions s
     WHERE (s.status = 'pending' AND s.run_at <= now())
        OR (s.status = 'running' AND s.claimed_at < now() - interval '5 minutes')
     ORDER BY s.run_at ASC LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  UPDATE public.scheduled_actions s
     SET status = 'running', claimed_at = now(), attempt = s.attempt + 1
    FROM picked WHERE s.id = picked.id
   RETURNING s.id, s.user_id, s.folder_action_id, s.email_id, s.attempt;
END; $$;
REVOKE EXECUTE ON FUNCTION public.claim_scheduled_actions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_scheduled_actions(integer) TO service_role;

DO $$ BEGIN PERFORM cron.unschedule('run-scheduled-actions-1m');
EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule('run-scheduled-actions-1m', '* * * * *',
  $$ SELECT private.cron_post('/api/public/hooks/run-scheduled-actions'); $$);

-- Task 6: thread-scope rules
ALTER TABLE public.folders ADD COLUMN IF NOT EXISTS run_on_threads boolean NOT NULL DEFAULT false;

-- Task 7: AI-derived sender categories
ALTER TABLE public.contact_groups
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'manual'
  CHECK (kind IN ('manual', 'ai_category', 'imported'));

DO $$ BEGIN PERFORM cron.unschedule('categorize-senders-nightly');
EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule('categorize-senders-nightly', '17 3 * * *',
  $$ SELECT private.cron_post('/api/public/hooks/categorize-senders'); $$);

-- Task 8: outbound action templates
CREATE OR REPLACE FUNCTION public.set_folder_action_template(
  p_action_id uuid, p_user_id uuid, p_subject text, p_body text, p_to text, p_key text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions' AS $$
DECLARE v_updated integer;
BEGIN
  IF length(coalesce(p_body, '')) > 4000 OR length(coalesce(p_subject, '')) > 500 THEN
    RAISE EXCEPTION 'template too long';
  END IF;
  UPDATE public.folder_actions
     SET subject_template = p_subject,
         body_template_enc = CASE WHEN p_body IS NULL OR p_body = '' THEN NULL
                                   ELSE private.encrypt_text(p_body, p_key) END,
         to_addr = p_to
   WHERE id = p_action_id AND user_id = p_user_id
     AND action_type IN ('reply', 'draft', 'send_email');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END; $$;
REVOKE EXECUTE ON FUNCTION public.set_folder_action_template(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_folder_action_template(uuid, uuid, text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_folder_action_outbound(p_action_id uuid, p_key text)
RETURNS TABLE(subject_template text, body_template text, to_addr text, cc_addr text, bcc_addr text)
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions' AS $$
  SELECT fa.subject_template,
    CASE WHEN fa.body_template_enc IS NULL THEN NULL
         ELSE private.decrypt_text(fa.body_template_enc, p_key) END,
    fa.to_addr, fa.cc_addr, fa.bcc_addr
  FROM public.folder_actions fa
  WHERE fa.id = p_action_id AND fa.action_type IN ('reply', 'draft', 'send_email');
$$;
REVOKE EXECUTE ON FUNCTION public.get_folder_action_outbound(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_folder_action_outbound(uuid, text) TO service_role;

-- Task 9: digest action
CREATE TABLE public.digest_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email_id uuid REFERENCES public.emails(id) ON DELETE CASCADE,
  bucket text NOT NULL CHECK (bucket IN ('daily', 'weekly')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX digest_items_pending_idx ON public.digest_items (user_id, bucket) WHERE sent_at IS NULL;
GRANT SELECT, DELETE ON public.digest_items TO authenticated;
GRANT ALL ON public.digest_items TO service_role;
ALTER TABLE public.digest_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY digest_items_owner ON public.digest_items
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  digest_hour integer NOT NULL DEFAULT 8 CHECK (digest_hour >= 0 AND digest_hour <= 23),
  digest_timezone text NOT NULL DEFAULT 'UTC' CHECK (length(digest_timezone) <= 64),
  digest_weekly_dow integer NOT NULL DEFAULT 1 CHECK (digest_weekly_dow >= 0 AND digest_weekly_dow <= 6),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.user_settings TO authenticated;
GRANT ALL ON public.user_settings TO service_role;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_settings_owner ON public.user_settings
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DO $$ BEGIN PERFORM cron.unschedule('send-digest-hourly');
EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule('send-digest-hourly', '7 * * * *',
  $$ SELECT private.cron_post('/api/public/hooks/send-digest'); $$);

-- Task 12: classification feedback
CREATE TABLE public.classification_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  executed_rule_id uuid REFERENCES public.executed_rules(id) ON DELETE CASCADE,
  correct_folder_id uuid REFERENCES public.folders(id) ON DELETE SET NULL,
  note text CHECK (note IS NULL OR length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX classification_feedback_user_idx ON public.classification_feedback (user_id, created_at DESC);
GRANT SELECT, INSERT ON public.classification_feedback TO authenticated;
GRANT ALL ON public.classification_feedback TO service_role;
ALTER TABLE public.classification_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY classification_feedback_owner ON public.classification_feedback
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Task 13: rules-ops retention
CREATE OR REPLACE FUNCTION public.cleanup_old_scheduled_actions(
  p_keep_days integer DEFAULT 30, p_keep_errors_days integer DEFAULT 60, p_batch_limit integer DEFAULT 5000
) RETURNS TABLE(deleted bigint, kept_errors bigint, total_before bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_cutoff_normal timestamptz := now() - make_interval(days => p_keep_days);
  v_cutoff_errors timestamptz := now() - make_interval(days => p_keep_errors_days);
  v_deleted bigint; v_kept_errors bigint; v_before bigint;
BEGIN
  SELECT COUNT(*) INTO v_before FROM public.scheduled_actions;
  WITH victims AS (
    SELECT id FROM public.scheduled_actions
     WHERE ((status IN ('done', 'cancelled') AND created_at < v_cutoff_normal)
        OR (status = 'error' AND created_at < v_cutoff_errors))
     ORDER BY created_at ASC LIMIT p_batch_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.scheduled_actions s USING victims WHERE s.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  SELECT COUNT(*) INTO v_kept_errors FROM public.scheduled_actions WHERE status = 'error';
  RETURN QUERY SELECT v_deleted, v_kept_errors, v_before;
END; $function$;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_scheduled_actions(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_scheduled_actions(integer, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.cleanup_old_digest_items(
  p_keep_days integer DEFAULT 30, p_batch_limit integer DEFAULT 5000
) RETURNS TABLE(deleted bigint, total_before bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_cutoff timestamptz := now() - make_interval(days => p_keep_days);
  v_deleted bigint; v_before bigint;
BEGIN
  SELECT COUNT(*) INTO v_before FROM public.digest_items;
  WITH victims AS (
    SELECT id FROM public.digest_items
     WHERE sent_at IS NOT NULL AND sent_at < v_cutoff
     ORDER BY sent_at ASC LIMIT p_batch_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.digest_items d USING victims WHERE d.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT v_deleted, v_before;
END; $function$;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_digest_items(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_digest_items(integer, integer) TO service_role;