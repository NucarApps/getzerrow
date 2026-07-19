-- Scrub webhook secrets from historical diagnostics + encryption-leak audit v3.
--
-- 1. TOKEN SCRUB
--    The gmail-webhook route used to record `${url.pathname}${url.search}`
--    into pubsub_events.subscription for unauthorized / legacy-auth pushes.
--    When the push URL carried the legacy `?token=<secret>`, the FULL shared
--    secret was persisted in plain text. The route now redacts before
--    logging (src/lib/pubsub-redact.ts); this migration retroactively scrubs
--    every historical row. `[^&[:space:]]+` leaves prose like
--    "no ?token= query param" untouched (no value follows the `=`).
--
-- 2. AUDIT V3
--    Widens audit_encryption_leaks() from 4 counters to full coverage:
--    every *_enc column across emails / gmail_accounts / reply_drafts /
--    contacts / folder_examples (empty-string ciphertext = a write bypassed
--    the encrypt RPC; the sanctioned RPCs store NULL or real ciphertext,
--    never ''), PLUS a search-index probe that counts rows still carrying
--    weight-C (body) lexemes — proving the 20260708090000 scrub holds.
--    Steady state for every counter = 0.
--
--    The return shape changes, so the function is dropped and recreated and
--    /api/public/health sums the returned counters generically from now on.

-- ─── 1. Scrub historical token leaks ─────────────────────────────────────
UPDATE public.pubsub_events
   SET subscription = regexp_replace(subscription, '(token=)[^&[:space:]]+', '\1<redacted>', 'gi')
 WHERE subscription ~* 'token=[^&[:space:]]+';

UPDATE public.pubsub_events
   SET details = regexp_replace(details, '(token=)[^&[:space:]]+', '\1<redacted>', 'gi')
 WHERE details ~* 'token=[^&[:space:]]+';

-- ─── 2. Encryption-leak audit v3 ─────────────────────────────────────────
DROP FUNCTION IF EXISTS public.audit_encryption_leaks();

CREATE FUNCTION public.audit_encryption_leaks()
  RETURNS TABLE(
    emails_content_leaks bigint,
    oauth_token_leaks bigint,
    reply_draft_leaks bigint,
    contact_field_leaks bigint,
    folder_example_leaks bigint,
    search_index_body_rows bigint
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT
    (SELECT count(*) FROM public.emails
       WHERE body_text_enc = '' OR body_html_enc = '' OR subject_enc = ''
          OR snippet_enc = '' OR from_name_enc = '' OR to_addrs_enc = ''
          OR cc_enc = '' OR ai_summary_enc = '' OR classification_reason_enc = '')::bigint,
    (SELECT count(*) FROM public.gmail_accounts
       WHERE access_token_enc = '' OR refresh_token_enc = '')::bigint,
    (SELECT count(*) FROM public.reply_drafts
       WHERE draft_text_enc = '')::bigint,
    (SELECT count(*) FROM public.contacts
       WHERE notes_enc = '' OR phone_enc = '' OR relationship_summary_enc = ''
          OR address_line1_enc = '' OR address_line2_enc = '')::bigint,
    (SELECT count(*) FROM public.folder_examples
       WHERE subject_enc = '' OR snippet_enc = '')::bigint,
    (SELECT count(*) FROM public.email_search_index
       WHERE tsv IS NOT NULL AND tsv <> ts_filter(tsv, '{a,b}'))::bigint;
$$;

REVOKE ALL ON FUNCTION public.audit_encryption_leaks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_encryption_leaks() TO service_role;

-- ─── Daily cron job (replaces the v2 definition) ─────────────────────────
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
        'emails_content',         emails_content_leaks,
        'oauth_tokens',           oauth_token_leaks,
        'reply_drafts',           reply_draft_leaks,
        'contact_fields',         contact_field_leaks,
        'folder_examples',        folder_example_leaks,
        'search_index_body_rows', search_index_body_rows
      )::text,
      'encryption bypass or body lexemes detected — investigate immediately'
    FROM leaks
    WHERE emails_content_leaks
        + oauth_token_leaks
        + reply_draft_leaks
        + contact_field_leaks
        + folder_example_leaks
        + search_index_body_rows > 0;
  $cron$
);

-- Operator tag.
INSERT INTO public.pubsub_events (event_type, details)
VALUES ('migration', 'webhook token logs scrubbed; encryption-leak audit v3 (full *_enc coverage + search-index body probe)');
