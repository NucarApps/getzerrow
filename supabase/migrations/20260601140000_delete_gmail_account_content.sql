-- Server-side purge of a single disconnected mailbox's synced content, used by
-- disconnectGmailAccount. Doing this in one SECURITY DEFINER function (one
-- round-trip, one implicit transaction) avoids fetching every email id into the
-- Cloudflare Worker and issuing hundreds of serial deletes — which on a large
-- mailbox risked a Worker timeout and a partial purge.
--
-- Scoped to (gmail_account_id, user_id). User-level config shared across
-- mailboxes (folders, filters, contacts) is intentionally left intact.
-- Returns the number of emails deleted (for the audit trail).
CREATE OR REPLACE FUNCTION public.delete_gmail_account_content(
  p_account_id uuid,
  p_user_id uuid
)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted bigint;
BEGIN
  -- email_id-keyed children first (they have no gmail_account_id of their own).
  DELETE FROM public.email_search_index
   WHERE email_id IN (
     SELECT id FROM public.emails
      WHERE gmail_account_id = p_account_id AND user_id = p_user_id
   );
  DELETE FROM public.reply_drafts
   WHERE email_id IN (
     SELECT id FROM public.emails
      WHERE gmail_account_id = p_account_id AND user_id = p_user_id
   );

  -- Mailbox-scoped content.
  DELETE FROM public.emails
   WHERE gmail_account_id = p_account_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  DELETE FROM public.calendar_contacts WHERE gmail_account_id = p_account_id AND user_id = p_user_id;
  DELETE FROM public.message_jobs      WHERE gmail_account_id = p_account_id AND user_id = p_user_id;
  DELETE FROM public.backfill_jobs     WHERE gmail_account_id = p_account_id AND user_id = p_user_id;

  RETURN v_deleted;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.delete_gmail_account_content(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_gmail_account_content(uuid, uuid) TO service_role;
