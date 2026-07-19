-- Custom company photo (uploaded logo). Companies can carry an uploaded
-- image that cascades to every member without their own photo. Stored in a
-- public bucket (logos aren't private) so one URL serves both the web <img>
-- and the server-side CardDAV download.

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS logo_url text;

INSERT INTO storage.buckets (id, name, public)
VALUES ('company-logos', 'company-logos', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Company logos are publicly readable"
ON storage.objects FOR SELECT
USING (bucket_id = 'company-logos');

CREATE POLICY "Users upload own company logos"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'company-logos'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users update own company logos"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'company-logos'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users delete own company logos"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'company-logos'
  AND auth.uid()::text = (storage.foldername(name))[1]
);
