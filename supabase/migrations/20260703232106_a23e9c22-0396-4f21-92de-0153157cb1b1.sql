-- Add owner-scoped read policies to folder alert/failure/retry diagnostic tables.
-- These tables are written server-side (service_role, which bypasses RLS).
-- Adding user-scoped SELECT policies lets the owning user read their own rows
-- while keeping everyone else fully fail-closed.

-- folder_retry_alerts: no user_id column; scope via join to owning folder.
GRANT SELECT ON public.folder_retry_alerts TO authenticated;
GRANT ALL ON public.folder_retry_alerts TO service_role;
CREATE POLICY "Users can view retry alerts for their folders"
  ON public.folder_retry_alerts
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.folders f
      WHERE f.id = folder_retry_alerts.folder_id
        AND f.user_id = auth.uid()
    )
  );

-- folder_write_alerts: no user_id column; scope via join to owning folder.
GRANT SELECT ON public.folder_write_alerts TO authenticated;
GRANT ALL ON public.folder_write_alerts TO service_role;
CREATE POLICY "Users can view write alerts for their folders"
  ON public.folder_write_alerts
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.folders f
      WHERE f.id = folder_write_alerts.folder_id
        AND f.user_id = auth.uid()
    )
  );

-- folder_write_failures: has user_id; scope directly to the owner.
GRANT SELECT ON public.folder_write_failures TO authenticated;
GRANT ALL ON public.folder_write_failures TO service_role;
CREATE POLICY "Users can view their own write failures"
  ON public.folder_write_failures
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- folder_write_retries: has user_id; scope directly to the owner.
GRANT SELECT ON public.folder_write_retries TO authenticated;
GRANT ALL ON public.folder_write_retries TO service_role;
CREATE POLICY "Users can view their own write retries"
  ON public.folder_write_retries
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);