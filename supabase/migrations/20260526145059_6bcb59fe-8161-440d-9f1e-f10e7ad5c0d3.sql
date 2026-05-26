
REVOKE ALL ON FUNCTION private.cron_watchdog() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.cron_watchdog() FROM anon, authenticated;
REVOKE ALL ON FUNCTION private.cron_post(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.cron_post(text) FROM anon, authenticated;
