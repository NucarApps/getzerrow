CREATE POLICY "No client access to cron settings"
ON private.cron_settings
FOR ALL
TO anon, authenticated
USING (false)
WITH CHECK (false);