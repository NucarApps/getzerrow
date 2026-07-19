-- Enum for meeting lifecycle status
DO $$ BEGIN
  CREATE TYPE public.meeting_status AS ENUM ('scheduled','joining','recording','done','failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE public.meeting_source AS ENUM ('link','calendar');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Meetings
CREATE TABLE public.meetings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gmail_account_id uuid REFERENCES public.gmail_accounts(id) ON DELETE SET NULL,
  recall_bot_id text,
  title text,
  meeting_url text NOT NULL,
  platform text,
  status public.meeting_status NOT NULL DEFAULT 'scheduled',
  source public.meeting_source NOT NULL DEFAULT 'link',
  calendar_event_id text,
  scheduled_start timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  recording_url text,
  transcript jsonb,
  summary text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meetings_user_idx ON public.meetings(user_id, created_at DESC);
CREATE INDEX meetings_recall_bot_idx ON public.meetings(recall_bot_id);
CREATE UNIQUE INDEX meetings_calendar_event_uidx
  ON public.meetings(user_id, calendar_event_id)
  WHERE calendar_event_id IS NOT NULL;
CREATE INDEX meetings_status_idx ON public.meetings(status) WHERE status <> 'done' AND status <> 'failed';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.meetings TO authenticated;
GRANT ALL ON public.meetings TO service_role;

ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own meetings"
  ON public.meetings FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Meeting participants
CREATE TABLE public.meeting_participants (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES public.meetings(id) ON DELETE CASCADE,
  email text,
  name text,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meeting_participants_meeting_idx ON public.meeting_participants(meeting_id);
CREATE INDEX meeting_participants_contact_idx ON public.meeting_participants(contact_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_participants TO authenticated;
GRANT ALL ON public.meeting_participants TO service_role;

ALTER TABLE public.meeting_participants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage participants of their meetings"
  ON public.meeting_participants FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.meetings m
    WHERE m.id = meeting_participants.meeting_id AND m.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.meetings m
    WHERE m.id = meeting_participants.meeting_id AND m.user_id = auth.uid()
  ));

-- updated_at trigger for meetings
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_meetings_updated_at
  BEFORE UPDATE ON public.meetings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Per-account auto-record toggle
ALTER TABLE public.gmail_accounts
  ADD COLUMN IF NOT EXISTS auto_record_meetings boolean NOT NULL DEFAULT false;