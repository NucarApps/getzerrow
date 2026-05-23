
ALTER TABLE public.my_cards ADD COLUMN IF NOT EXISTS cover_url text;

INSERT INTO storage.buckets (id, name, public)
VALUES ('card-images', 'card-images', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Card images are publicly readable"
ON storage.objects FOR SELECT
USING (bucket_id = 'card-images');

CREATE POLICY "Users upload own card images"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'card-images'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users update own card images"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'card-images'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users delete own card images"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'card-images'
  AND auth.uid()::text = (storage.foldername(name))[1]
);
