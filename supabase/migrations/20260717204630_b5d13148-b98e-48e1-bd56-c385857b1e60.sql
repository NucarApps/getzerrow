
CREATE POLICY "deny all" ON public.meeting_transcript_buffer FOR ALL TO authenticated USING (false) WITH CHECK (false);
