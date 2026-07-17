DROP POLICY IF EXISTS "Users can manage their own calendar selections" ON public.meeting_calendar_selections;
CREATE POLICY "Users can manage their own calendar selections"
  ON public.meeting_calendar_selections FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users manage participants of their meetings" ON public.meeting_participants;
CREATE POLICY "Users manage participants of their meetings"
  ON public.meeting_participants FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.meetings m WHERE m.id = meeting_participants.meeting_id AND m.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.meetings m WHERE m.id = meeting_participants.meeting_id AND m.user_id = auth.uid()));