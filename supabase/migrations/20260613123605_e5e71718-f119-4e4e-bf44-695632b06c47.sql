-- Lock down the decrypted list RPC: server (service_role) only.
REVOKE ALL ON FUNCTION public.get_emails_list_decrypted(uuid, uuid, text, uuid, timestamptz, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_emails_list_decrypted(uuid, uuid, text, uuid, timestamptz, integer, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_emails_list_decrypted(uuid, uuid, text, uuid, timestamptz, integer, text) TO service_role;

-- Unread counts: signed-in users + server only (function is scoped by auth.uid()).
REVOKE ALL ON FUNCTION public.get_folder_unread_counts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_folder_unread_counts(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_folder_unread_counts(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_folder_unread_counts(uuid) TO service_role;