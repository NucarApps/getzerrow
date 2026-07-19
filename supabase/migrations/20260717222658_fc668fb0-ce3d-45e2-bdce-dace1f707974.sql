CREATE TABLE public.carddav_settings (
  user_id UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  group_name_style TEXT NOT NULL DEFAULT 'path_slash' CHECK (group_name_style IN ('leaf','path_slash','path_dash')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.carddav_settings TO authenticated;
GRANT ALL ON public.carddav_settings TO service_role;
ALTER TABLE public.carddav_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own carddav settings"
  ON public.carddav_settings FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER carddav_settings_set_updated_at
  BEFORE UPDATE ON public.carddav_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
