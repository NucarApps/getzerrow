ALTER TABLE public.meeting_bot_settings
  ADD COLUMN IF NOT EXISTS auto_leave_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_leave_minutes integer NOT NULL DEFAULT 30;