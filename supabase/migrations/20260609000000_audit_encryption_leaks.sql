-- Encryption-leak audit.
--
-- Why
--   emails.body_text / body_html and gmail_accounts.access_token /
--   refresh_token are kept as columns on the underlying tables, but they
--   are supposed to be zeroed:
--     * body_text/body_html  → '' by emails_encrypt_body BEFORE trigger
--     * access_token/refresh_token → '' by set_gmail_oauth_tokens /
--       upsert_gmail_oauth_account RPCs
--
--   If any row holds a non-empty value in those columns, something
--   bypassed the encryption path (raw SQL UPDATE, trigger disabled,
--   broken RPC). This migration adds an audit function + a daily pg_cron
--   job that writes a `pubsub_events` row when leaks are detected, so
--   the existing operator dashboard surfaces it.
--
-- Design
--   * audit_encryption_leaks() returns four counts. Cheap — covered by
--     existing primary-key scans + small WHERE filter.
--   * Cron job only INSERTS when leaks > 0, so steady-state is silent
--     and pubsub_events doesn't get spammed.
--   * Errors go into pubsub_events.error so the existing
--     "errors24" diagnostics counter flags them.
--
-- Operator action: none. Watch pubsub_events for
-- event_type='encryption_leak_audit' rows.

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.audit_encryption_leaks()
  RETURNS TABLE(
    emails_body_text_leaks bigint,
    emails_body_html_leaks bigint,
    oauth_access_token_leaks bigint,
    oauth_refresh_token_leaks bigint
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT
    (SELECT count(*) FROM public.emails
       WHERE body_text IS NOT NULL AND length(body_text) > 0)::bigint,
    (SELECT count(*) FROM public.emails
       WHERE body_html IS NOT NULL AND length(body_html) > 0)::bigint,
    (SELECT count(*) FROM public.gmail_accounts
       WHERE access_token IS NOT NULL AND length(access_token) > 0)::bigint,
    (SELECT count(*) FROM public.gmail_accounts
       WHERE refresh_token IS NOT NULL AND length(refresh_token) > 0)::bigint;
$$;

REVOKE ALL ON FUNCTION public.audit_encryption_leaks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_encryption_leaks() TO service_role;

-- ─── Daily cron job ──────────────────────────────────────────────────────
-- 4:17 AM UTC — off-peak. Only writes a row when something leaked.
-- Unschedule first so re-running this migration replaces the job
-- definition instead of failing on "job exists".
DO $$
BEGIN
  PERFORM cron.unschedule('audit-encryption-leaks');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'audit-encryption-leaks',
  '17 4 * * *',
  $cron$
    WITH leaks AS (
      SELECT * FROM public.audit_encryption_leaks()
    )
    INSERT INTO public.pubsub_events (event_type, details, error)
    SELECT
      'encryption_leak_audit',
      jsonb_build_object(
        'body_text',     emails_body_text_leaks,
        'body_html',     emails_body_html_leaks,
        'access_token',  oauth_access_token_leaks,
        'refresh_token', oauth_refresh_token_leaks
      )::text,
      'plaintext leak detected — encryption trigger or OAuth RPC malfunctioning'
    FROM leaks
    WHERE emails_body_text_leaks
        + emails_body_html_leaks
        + oauth_access_token_leaks
        + oauth_refresh_token_leaks > 0;
  $cron$
);

-- Operator tag.
INSERT INTO public.pubsub_events (event_type, details)
VALUES ('migration', 'encryption-leak audit scheduled (daily 04:17 UTC)');
