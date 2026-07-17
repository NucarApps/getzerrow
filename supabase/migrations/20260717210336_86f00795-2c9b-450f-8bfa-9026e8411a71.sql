
CREATE TABLE public.carddav_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'iPhone',
  token_hash text NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX carddav_tokens_user_id_idx ON public.carddav_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX carddav_tokens_hash_idx ON public.carddav_tokens(token_hash) WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.carddav_tokens TO authenticated;
GRANT ALL ON public.carddav_tokens TO service_role;

ALTER TABLE public.carddav_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own carddav tokens"
  ON public.carddav_tokens FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER carddav_tokens_updated_at
  BEFORE UPDATE ON public.carddav_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- SECURITY DEFINER: the public CardDAV endpoint verifies a token by its hash
-- without needing any RLS-protected read. Returns the owning user_id when
-- the token is valid and not revoked, NULL otherwise. Also bumps last_used_at.
CREATE OR REPLACE FUNCTION public.verify_carddav_token(p_user_email text, p_token_hash text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_token_id uuid;
BEGIN
  SELECT u.id INTO v_user_id
    FROM auth.users u
   WHERE lower(u.email) = lower(p_user_email)
   LIMIT 1;
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_token_id
    FROM public.carddav_tokens
   WHERE user_id = v_user_id
     AND token_hash = p_token_hash
     AND revoked_at IS NULL
   LIMIT 1;
  IF v_token_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.carddav_tokens
     SET last_used_at = now()
   WHERE id = v_token_id;

  RETURN v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_carddav_token(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.verify_carddav_token(text, text) TO service_role;
