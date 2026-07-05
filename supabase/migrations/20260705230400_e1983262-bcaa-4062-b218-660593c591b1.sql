CREATE TABLE public.meeting_record_blocklist (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, value)
);

GRANT SELECT, INSERT, DELETE ON public.meeting_record_blocklist TO authenticated;
GRANT ALL ON public.meeting_record_blocklist TO service_role;

ALTER TABLE public.meeting_record_blocklist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own record blocklist"
  ON public.meeting_record_blocklist FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can add to their own record blocklist"
  ON public.meeting_record_blocklist FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can remove from their own record blocklist"
  ON public.meeting_record_blocklist FOR DELETE TO authenticated
  USING (auth.uid() = user_id);