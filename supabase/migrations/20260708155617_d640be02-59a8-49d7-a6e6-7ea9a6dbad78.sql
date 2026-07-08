ALTER TABLE public.meeting_autojoin_exclusions
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'off';