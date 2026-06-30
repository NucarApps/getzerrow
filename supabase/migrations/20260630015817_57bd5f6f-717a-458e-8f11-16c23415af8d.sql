REVOKE EXECUTE ON FUNCTION public.search_emails_participants(uuid, text, text, text, integer, integer, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reindex_email_participants(integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_emails_participants(uuid, text, text, text, integer, integer, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reindex_email_participants(integer, text) TO service_role;