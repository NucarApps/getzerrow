-- 1. Private bucket for scanned business cards
INSERT INTO storage.buckets (id, name, public)
VALUES ('contact-cards', 'contact-cards', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Owners read own contact cards" ON storage.objects;
CREATE POLICY "Owners read own contact cards"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'contact-cards' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Owners insert own contact cards" ON storage.objects;
CREATE POLICY "Owners insert own contact cards"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'contact-cards' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Owners update own contact cards" ON storage.objects;
CREATE POLICY "Owners update own contact cards"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'contact-cards' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Owners delete own contact cards" ON storage.objects;
CREATE POLICY "Owners delete own contact cards"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'contact-cards' AND auth.uid()::text = (storage.foldername(name))[1]);

-- 2. Drop broad public SELECT on card-images (public file URLs still work via /object/public)
DROP POLICY IF EXISTS "Card images are publicly readable" ON storage.objects;

-- 3. Revoke anonymous EXECUTE on user-scoped SECURITY DEFINER functions
REVOKE EXECUTE ON FUNCTION public.get_invader_stats() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.list_my_gmail_accounts_with_status() FROM anon;
