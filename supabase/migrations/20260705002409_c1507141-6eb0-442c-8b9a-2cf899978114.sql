CREATE POLICY "Users manage own meeting recordings - select"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'meeting-recordings' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users manage own meeting recordings - insert"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'meeting-recordings' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users manage own meeting recordings - delete"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'meeting-recordings' AND (storage.foldername(name))[1] = auth.uid()::text);