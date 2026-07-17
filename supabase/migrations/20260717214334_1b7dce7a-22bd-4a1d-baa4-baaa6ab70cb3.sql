CREATE TABLE public.carddav_tombstones (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  resource_type text NOT NULL CHECK (resource_type IN ('contact','group')),
  resource_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  sync_seq bigserial NOT NULL,
  PRIMARY KEY (user_id, resource_type, resource_id)
);

CREATE INDEX carddav_tombstones_user_seq_idx
  ON public.carddav_tombstones (user_id, sync_seq);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.carddav_tombstones TO authenticated;
GRANT ALL ON public.carddav_tombstones TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.carddav_tombstones_sync_seq_seq TO authenticated, service_role;

ALTER TABLE public.carddav_tombstones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own carddav tombstones"
  ON public.carddav_tombstones FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.prune_carddav_tombstones(p_keep_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_deleted integer;
BEGIN
  DELETE FROM public.carddav_tombstones
   WHERE deleted_at < now() - make_interval(days => GREATEST(1, p_keep_days));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;