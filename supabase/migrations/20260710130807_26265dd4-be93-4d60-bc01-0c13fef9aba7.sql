CREATE TABLE public.meeting_calendar_selections (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gmail_account_id uuid NOT NULL REFERENCES public.gmail_accounts(id) ON DELETE CASCADE,
  calendar_id text NOT NULL,
  calendar_summary text,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (gmail_account_id, calendar_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_calendar_selections TO authenticated;
GRANT ALL ON public.meeting_calendar_selections TO service_role;

ALTER TABLE public.meeting_calendar_selections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own calendar selections"
ON public.meeting_calendar_selections
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_meeting_calendar_selections_account
  ON public.meeting_calendar_selections (gmail_account_id);

CREATE TRIGGER update_meeting_calendar_selections_updated_at
  BEFORE UPDATE ON public.meeting_calendar_selections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();