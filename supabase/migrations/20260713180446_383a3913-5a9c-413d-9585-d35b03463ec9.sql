ALTER TABLE public.meeting_bot_settings
  ADD COLUMN IF NOT EXISTS hidden_event_types text[] NOT NULL DEFAULT '{outOfOffice,workingLocation,focusTime,birthday}',
  ADD COLUMN IF NOT EXISTS event_color_skip text[] NOT NULL DEFAULT '{}';