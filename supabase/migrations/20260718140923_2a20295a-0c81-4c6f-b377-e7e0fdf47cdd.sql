-- Storage policies for contact-photos: users read/write only under their own user_id/ folder.
CREATE POLICY "contact_photos_read_own"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'contact-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "contact_photos_insert_own"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'contact-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "contact_photos_update_own"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'contact-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "contact_photos_delete_own"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'contact-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Google People API returns a photo etag we can compare against for delta pulls.
ALTER TABLE public.google_contact_links
  ADD COLUMN IF NOT EXISTS photo_etag text;

-- Bump CardDAV resync so iPhones re-fetch every vCard and see the new PHOTO line.
UPDATE public.carddav_settings
   SET resync_nonce = COALESCE(resync_nonce, 0) + 1,
       updated_at = now();
