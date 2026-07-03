REVOKE ALL ON FUNCTION public.get_emails_list_decrypted(uuid, uuid, text, uuid, timestamptz, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_emails_list_decrypted(uuid, uuid, text, uuid, timestamptz, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.get_emails_list_decrypted(uuid, uuid, text, uuid, timestamptz, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_emails_list_decrypted(uuid, uuid, text, uuid, timestamptz, integer, text) TO service_role;