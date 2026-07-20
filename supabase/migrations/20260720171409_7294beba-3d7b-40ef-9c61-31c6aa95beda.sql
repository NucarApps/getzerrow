UPDATE public.google_contact_links
SET last_synced_at = 'epoch'::timestamptz
WHERE last_synced_at > 'epoch'::timestamptz
  AND last_synced_at < now() - interval '10 minutes';

-- Nudge unlinked contacts (no google_contact_links row) into the dirty scan
-- so they get created in Google on the next tick.
UPDATE public.contacts c
SET updated_at = now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.google_contact_links l WHERE l.contact_id = c.id
);