alter table public.folders
  add column if not exists gmail_backfill_page_token text,
  add column if not exists gmail_backfill_oldest_received_at timestamptz;