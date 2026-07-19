
CREATE TABLE public.meeting_transcript_buffer (
  bot_id text PRIMARY KEY,
  meeting_id uuid REFERENCES public.meetings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  segments jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_trigger_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.meeting_transcript_buffer TO service_role;
ALTER TABLE public.meeting_transcript_buffer ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.meeting_qa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id text NOT NULL,
  meeting_id uuid REFERENCES public.meetings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  trigger_source text NOT NULL CHECK (trigger_source IN ('voice','chat')),
  asker text,
  question text NOT NULL,
  answer text,
  latency_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_qa_meeting_idx ON public.meeting_qa(meeting_id, created_at DESC);
GRANT SELECT ON public.meeting_qa TO authenticated;
GRANT ALL ON public.meeting_qa TO service_role;
ALTER TABLE public.meeting_qa ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own meeting qa" ON public.meeting_qa FOR SELECT TO authenticated USING (user_id = auth.uid());
