GRANT INSERT ON public.google_contact_tombstones TO authenticated;

CREATE POLICY "Users insert their google tombstones"
  ON public.google_contact_tombstones
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);