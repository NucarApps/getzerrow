-- Restore the slim realtime feed for emails.
--
-- WHY
--   20260525190000_realtime_drop_body_columns.sql published `emails` with a
--   slim column list so postgres_changes payloads stay small enough for the
--   realtime websocket (oversized payloads are dropped by the realtime
--   service and never reach subscribers).
--
--   20260528105923 (encryption at rest) had to DROP the table from the
--   publication to drop the plaintext columns, then re-added it WITHOUT a
--   column list. Since then every INSERT/UPDATE payload has carried
--   body_text_enc / body_html_enc — often several megabytes — so most email
--   events get dropped in flight. That is why open tabs stopped updating
--   live and only looked right after a reload.
--
-- WHAT
--   Re-add `emails` to supabase_realtime publishing every CURRENT column
--   except the encrypted blobs. Ciphertext is useless to the browser anyway:
--   the web client decrypts on-demand through server functions
--   (getEmailListFields / get_emails_list_decrypted), and the iOS client
--   treats realtime purely as a change signal. The column list is built
--   dynamically so it stays correct regardless of columns added since May.
--
-- NOTES
--   - `emails` is REPLICA IDENTITY DEFAULT (set 20260525131051), so a column
--     list is legal — it must cover the replica identity, and `id` is always
--     included.
--   - DELETE payloads carry only the primary key, exactly like the May 25
--     slim-feed state. Subscribers only read `old.id`.
--   - contacts / folders / reply_drafts / folder_examples stay published as
--     they are (small rows).

DO $$
DECLARE
  cols text;
BEGIN
  IF to_regclass('public.emails') IS NULL THEN
    RAISE NOTICE 'public.emails does not exist; skipping realtime slimming';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'supabase_realtime publication does not exist; skipping realtime slimming';
    RETURN;
  END IF;

  BEGIN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.emails;
  EXCEPTION WHEN undefined_object THEN
    NULL; -- table was not in the publication; nothing to drop
  END;

  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
    INTO cols
    FROM pg_attribute
   WHERE attrelid = 'public.emails'::regclass
     AND attnum > 0
     AND NOT attisdropped
     AND attname NOT IN (
       'body_text_enc',
       'body_html_enc',
       'subject_enc',
       'snippet_enc',
       'from_name_enc',
       'to_addrs_enc',
       'cc_enc',
       'ai_summary_enc',
       'classification_reason_enc'
     );

  EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.emails (%s)', cols);
END $$;
