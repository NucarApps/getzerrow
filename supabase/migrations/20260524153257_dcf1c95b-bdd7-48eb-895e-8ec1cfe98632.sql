-- Revoke column-level SELECT on sensitive OAuth tokens from client roles.
-- RLS still restricts which rows are visible (auth.uid() = user_id), but
-- column privileges now prevent the access_token / refresh_token columns
-- from being returned to clients at all. Server-side code using the
-- service_role key bypasses these grants and continues to work.
REVOKE SELECT (access_token, refresh_token) ON public.gmail_accounts FROM authenticated;
REVOKE SELECT (access_token, refresh_token) ON public.gmail_accounts FROM anon;
