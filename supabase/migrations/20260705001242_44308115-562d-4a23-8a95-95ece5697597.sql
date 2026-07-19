CREATE TABLE public.meeting_bot_settings (
  user_id uuid NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_name text NOT NULL DEFAULT 'Zerrow Notetaker',
  chat_message text NOT NULL DEFAULT '',
  chat_resend_on_join boolean NOT NULL DEFAULT true,
  avatar_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_bot_settings TO authenticated;
GRANT ALL ON public.meeting_bot_settings TO service_role;

ALTER TABLE public.meeting_bot_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own meeting bot settings"
  ON public.meeting_bot_settings
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER meeting_bot_settings_set_updated_at
  BEFORE UPDATE ON public.meeting_bot_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();