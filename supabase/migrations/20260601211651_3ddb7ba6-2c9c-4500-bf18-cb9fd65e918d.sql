ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS is_cold_email boolean NOT NULL DEFAULT false;

-- Seed: treat any existing folder named like "Cold Email" as the cold-email
-- folder so the calendar guard protects it out of the box.
UPDATE public.folders
   SET is_cold_email = true
 WHERE lower(name) LIKE '%cold email%'
    OR lower(name) LIKE '%cold outreach%';