alter table public.google_contact_links
  add column if not exists last_photo_error text,
  add column if not exists last_photo_error_at timestamptz,
  add column if not exists last_photo_status integer,
  add column if not exists last_photo_reason text;