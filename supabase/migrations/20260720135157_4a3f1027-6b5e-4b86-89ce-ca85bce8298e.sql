DROP POLICY IF EXISTS "Users upload own card images" ON storage.objects;
CREATE POLICY "Users upload own card images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'card-images'
  AND auth.uid()::text = (storage.foldername(name))[1]
  AND EXISTS (SELECT 1 FROM public.my_cards mc WHERE mc.user_id = auth.uid())
);

DROP POLICY IF EXISTS "Users update own card images" ON storage.objects;
CREATE POLICY "Users update own card images"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'card-images'
  AND auth.uid()::text = (storage.foldername(name))[1]
  AND EXISTS (SELECT 1 FROM public.my_cards mc WHERE mc.user_id = auth.uid())
);

DROP POLICY IF EXISTS "Users delete own card images" ON storage.objects;
CREATE POLICY "Users delete own card images"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'card-images'
  AND auth.uid()::text = (storage.foldername(name))[1]
  AND EXISTS (SELECT 1 FROM public.my_cards mc WHERE mc.user_id = auth.uid())
);

REVOKE SELECT ON public.my_cards FROM anon;