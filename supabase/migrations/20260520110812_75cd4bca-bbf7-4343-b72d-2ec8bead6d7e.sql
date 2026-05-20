CREATE TABLE public.folder_summary_schedules (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  folder_id uuid NOT NULL,
  gmail_account_id uuid NOT NULL,
  name text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  hour int NOT NULL CHECK (hour >= 0 AND hour <= 23),
  minute int NOT NULL CHECK (minute >= 0 AND minute <= 59),
  timezone text NOT NULL DEFAULT 'UTC',
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  next_run_at timestamptz NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.folder_summary_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own folder summary schedules"
ON public.folder_summary_schedules
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_folder_summary_schedules_due
  ON public.folder_summary_schedules (enabled, next_run_at);

CREATE INDEX idx_folder_summary_schedules_folder
  ON public.folder_summary_schedules (folder_id);

CREATE TRIGGER set_folder_summary_schedules_updated_at
  BEFORE UPDATE ON public.folder_summary_schedules
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();