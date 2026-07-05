ALTER TYPE public.meeting_source ADD VALUE IF NOT EXISTS 'in_person';
ALTER TYPE public.meeting_status ADD VALUE IF NOT EXISTS 'processing';
ALTER TABLE public.meetings ALTER COLUMN meeting_url DROP NOT NULL;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS audio_storage_path text;