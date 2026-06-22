REVOKE EXECUTE ON FUNCTION public.get_emails_list_decrypted(uuid, uuid, text, uuid, timestamp with time zone, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_emails_list_decrypted(uuid, uuid, text, uuid, timestamp with time zone, integer, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.get_folder_unread_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_folder_unread_counts(uuid) TO authenticated, service_role;