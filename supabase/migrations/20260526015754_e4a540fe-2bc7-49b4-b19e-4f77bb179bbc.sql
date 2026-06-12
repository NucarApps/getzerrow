ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS card_image_url text;

-- Storage policies for card-images bucket (per-user folder)
DROP POLICY IF EXISTS "Users upload own card images" ON storage.objects;
CREATE POLICY "Users upload own card images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'card-images' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Users update own card images" ON storage.objects;
CREATE POLICY "Users update own card images"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'card-images' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Users delete own card images" ON storage.objects;
CREATE POLICY "Users delete own card images"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'card-images' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Card images are publicly readable" ON storage.objects;
CREATE POLICY "Card images are publicly readable"
ON storage.objects FOR SELECT
USING (bucket_id = 'card-images');