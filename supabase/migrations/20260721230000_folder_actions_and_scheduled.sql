-- Rules-engine action fan-out foundation (rules upgrade, task 4).
-- Decouples actions from folder columns: explicit per-folder action rows
-- (folder_actions) plus a delayed-execution queue (scheduled_actions).
-- The legacy folder flags (auto_archive, auto_mark_read, auto_star,
-- hide_from_inbox, forward_to, snooze_hours) keep working as implicit
-- actions — the dispatcher maps them to synthetic in-memory actions when
-- no explicit row of that type exists.
--
-- Encrypted columns (body_template_enc, webhook_secret_enc) are reserved
-- for the reply/webhook action types (tasks 5 and 8); nothing writes them
-- yet and they must only ever be written via encrypting service-role RPCs.

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
  -- move_folder target (not in the original sketch, which had no way to
  -- express where to move; additive column).
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

ALTER TABLE public.folder_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own folder actions" ON public.folder_actions
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.folders f
       WHERE f.id = folder_id AND f.user_id = auth.uid()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.folder_actions TO authenticated;
GRANT ALL ON public.folder_actions TO service_role;

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

ALTER TABLE public.scheduled_actions ENABLE ROW LEVEL SECURITY;

-- Users can read (and cancel) their own scheduled actions; rows are
-- created by the server-side dispatcher, not the client.
CREATE POLICY "Users view own scheduled actions" ON public.scheduled_actions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users cancel own scheduled actions" ON public.scheduled_actions
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

GRANT SELECT, UPDATE ON public.scheduled_actions TO authenticated;
GRANT ALL ON public.scheduled_actions TO service_role;
