
CREATE POLICY "Users insert own extraction runs" ON public.task_extraction_runs
  FOR INSERT WITH CHECK (auth.uid() = user_id);
