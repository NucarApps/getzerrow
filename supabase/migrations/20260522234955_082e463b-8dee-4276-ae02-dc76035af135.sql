ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS relationship_summary text,
  ADD COLUMN IF NOT EXISTS summary_generated_at timestamptz;