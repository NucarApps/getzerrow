-- Encryption-leak audit, v2 — reconciled with the live encrypt-on-write schema.
--
-- Why a v2
--   The original 20260609000000_audit_encryption_leaks.sql counted non-empty
--   PLAINTEXT columns (emails.body_text / body_html, gmail_accounts.access_token
--   / refresh_token). Those columns were dropped in the Phase 3b column-drop
--   migration — the live tables hold only ciphertext in *_enc columns — so the
--   original function can no longer be created (missing-column error). It was
--   deleted; this re-establishes the audit against the real schema.
--
-- What counts as a leak now (encrypt-on-write)
--   Sensitive fields are written exclusively through the SECURITY DEFINER
--   encrypt RPCs (upsert_email_encrypted / update_email_encrypted /
--   set_gmail_oauth_tokens / upsert_gmail_oauth_account). Given content those
--   RPCs store real ciphertext; given no content they store NULL. They NEVER
--   store an empty string. So an empty-string *_enc value is impossible through
--   the sanctioned path — it can only come from a raw write that bypassed
--   encryption. Counting *_enc = '' is therefore a false-positive-free signal
--   that a write skipped the encrypt RPC. Steady state = 0.
--
--   (key_version can't be used: emails.key_version is NOT NULL DEFAULT 1 and
--   gmail_accounts has no key_version column.)
--
-- Design
--   * audit_encryption_leaks() returns four counts. Cheap — small WHERE filter
--     over the primary-key scans.
--   * Cron job only INSERTS when leaks > 0, so steady-state is silent and
--     pubsub_events doesn't get spammed.
--   * Errors go into pubsub_events.error so the existing "errors24" diagnostics
--     counter flags them.
--   * Return shape is unchanged so /api/public/health's LeakRow keeps working.
--
-- Operator action: none. Watch pubsub_events for
-- event_type='encryption_leak_audit' rows.

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
       WHERE body_text_enc = '')::bigint,
    (SELECT count(*) FROM public.emails
       WHERE body_html_enc = '')::bigint,
    (SELECT count(*) FROM public.gmail_accounts
       WHERE access_token_enc = '')::bigint,
    (SELECT count(*) FROM public.gmail_accounts
       WHERE refresh_token_enc = '')::bigint;
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
      'empty-ciphertext detected — a write bypassed the encrypt RPC'
    FROM leaks
    WHERE emails_body_text_leaks
        + emails_body_html_leaks
        + oauth_access_token_leaks
        + oauth_refresh_token_leaks > 0;
  $cron$
);

-- Operator tag.
INSERT INTO public.pubsub_events (event_type, details)
VALUES ('migration', 'encryption-leak audit v2 scheduled (daily 04:17 UTC)');
