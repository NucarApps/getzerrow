CREATE TABLE public.inbox_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  match_type text NOT NULL CHECK (match_type IN ('email','domain')),
  value text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, match_type, value)
);

ALTER TABLE public.inbox_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own inbox overrides"
ON public.inbox_overrides
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX inbox_overrides_user_idx ON public.inbox_overrides (user_id);