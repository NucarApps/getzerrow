
CREATE OR REPLACE FUNCTION public.list_my_gmail_accounts_with_status()
RETURNS TABLE(
  id uuid,
  email_address text,
  history_id text,
  watch_expiration timestamptz,
  last_poll_at timestamptz,
  created_at timestamptz,
  refresh_token_present boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ga.id,
    ga.email_address,
    ga.history_id,
    ga.watch_expiration,
    ga.last_poll_at,
    ga.created_at,
    (ga.refresh_token_enc IS NOT NULL) AS refresh_token_present
  FROM public.gmail_accounts ga
  WHERE ga.user_id = auth.uid()
  ORDER BY ga.created_at ASC;
$$;

REVOKE ALL ON FUNCTION public.list_my_gmail_accounts_with_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_my_gmail_accounts_with_status() TO authenticated;
