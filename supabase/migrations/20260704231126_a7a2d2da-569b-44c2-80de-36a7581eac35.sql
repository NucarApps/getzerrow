CREATE TABLE public.meeting_autojoin_exclusions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gmail_account_id UUID NOT NULL REFERENCES public.gmail_accounts(id) ON DELETE CASCADE,
  calendar_event_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, calendar_event_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_autojoin_exclusions TO authenticated;
GRANT ALL ON public.meeting_autojoin_exclusions TO service_role;

ALTER TABLE public.meeting_autojoin_exclusions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own autojoin exclusions"
ON public.meeting_autojoin_exclusions
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_meeting_autojoin_exclusions_user_event
ON public.meeting_autojoin_exclusions (user_id, calendar_event_id);