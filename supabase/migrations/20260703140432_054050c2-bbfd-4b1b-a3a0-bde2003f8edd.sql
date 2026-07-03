ALTER TABLE public.folder_write_failures ADD COLUMN IF NOT EXISTS correlation_id uuid;
CREATE INDEX IF NOT EXISTS idx_fwf_correlation ON public.folder_write_failures (correlation_id);