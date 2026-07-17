ALTER TABLE public.contacts ALTER COLUMN email DROP NOT NULL;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_user_email_key;
DROP INDEX IF EXISTS public.contacts_user_email_unique;
CREATE UNIQUE INDEX contacts_user_email_unique
  ON public.contacts (user_id, lower(email))
  WHERE email IS NOT NULL;