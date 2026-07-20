
ALTER TABLE public.google_contact_links
  ADD COLUMN IF NOT EXISTS google_photo_url text;

-- One-shot reset: unstick any linked contacts with a local photo that
-- haven't been pushed yet, so the next push cycle attempts them.
UPDATE public.google_contact_links g
   SET photo_push_attempts = 0,
       photo_etag = NULL
  FROM public.contacts c
 WHERE g.contact_id = c.id
   AND c.avatar_url IS NOT NULL;
