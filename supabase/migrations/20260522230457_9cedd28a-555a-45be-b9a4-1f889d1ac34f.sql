-- Dedupe duplicates first
DELETE FROM public.contacts c
USING public.contacts c2
WHERE c.user_id = c2.user_id
  AND c.email = c2.email
  AND c.created_at > c2.created_at;

-- Add unique constraint required by ON CONFLICT (user_id, email)
ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_user_email_key UNIQUE (user_id, email);