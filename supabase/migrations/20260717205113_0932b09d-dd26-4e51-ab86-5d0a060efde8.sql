
-- 1) tasks
CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  due_at timestamptz,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','meeting','email')),
  source_meeting_id uuid REFERENCES public.meetings(id) ON DELETE SET NULL,
  source_email_id uuid REFERENCES public.emails(id) ON DELETE SET NULL,
  source_snippet text,
  completed_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_user_status_idx ON public.tasks(user_id, status, created_at DESC);
CREATE INDEX tasks_meeting_idx ON public.tasks(source_meeting_id) WHERE source_meeting_id IS NOT NULL;
CREATE INDEX tasks_email_idx ON public.tasks(source_email_id) WHERE source_email_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated;
GRANT ALL ON public.tasks TO service_role;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own tasks" ON public.tasks
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2) task_completion_suggestions
CREATE TABLE public.task_completion_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  sent_email_id uuid REFERENCES public.emails(id) ON DELETE SET NULL,
  confidence text NOT NULL CHECK (confidence IN ('high','med','low')),
  reasoning text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, sent_email_id)
);
CREATE INDEX tcs_user_task_idx ON public.task_completion_suggestions(user_id, task_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_completion_suggestions TO authenticated;
GRANT ALL ON public.task_completion_suggestions TO service_role;
ALTER TABLE public.task_completion_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own task suggestions" ON public.task_completion_suggestions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 3) task_extraction_runs (idempotency guard)
CREATE TABLE public.task_extraction_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('meeting','email_in','email_out','sent_scan')),
  source_id text NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_type, source_id)
);
GRANT SELECT, INSERT ON public.task_extraction_runs TO authenticated;
GRANT ALL ON public.task_extraction_runs TO service_role;
ALTER TABLE public.task_extraction_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own extraction runs" ON public.task_extraction_runs
  FOR SELECT USING (auth.uid() = user_id);
