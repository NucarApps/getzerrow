CREATE TABLE public.game_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  game text NOT NULL DEFAULT 'invader',
  score integer NOT NULL CHECK (score >= 0 AND score <= 10000000),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX game_scores_game_score_idx ON public.game_scores (game, score DESC);
CREATE INDEX game_scores_user_score_idx ON public.game_scores (user_id, score DESC);

ALTER TABLE public.game_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users insert own scores" ON public.game_scores
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users view own scores" ON public.game_scores
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.get_invader_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_my_best int;
  v_global_best int;
  v_my_rank int;
  v_top5 jsonb;
BEGIN
  SELECT MAX(score) INTO v_my_best
    FROM public.game_scores
   WHERE game = 'invader' AND user_id = v_uid;

  SELECT MAX(score) INTO v_global_best
    FROM public.game_scores
   WHERE game = 'invader';

  IF v_my_best IS NOT NULL THEN
    SELECT COUNT(*) + 1 INTO v_my_rank
      FROM (
        SELECT user_id, MAX(score) AS best
          FROM public.game_scores
         WHERE game = 'invader'
         GROUP BY user_id
      ) t
     WHERE t.best > v_my_best;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', display_name, 'score', score) ORDER BY score DESC), '[]'::jsonb)
    INTO v_top5
    FROM (
      SELECT DISTINCT ON (user_id) user_id, display_name, score
        FROM public.game_scores
       WHERE game = 'invader'
       ORDER BY user_id, score DESC
    ) per_user
   WHERE score IS NOT NULL
   LIMIT 5;

  -- jsonb_agg with LIMIT in subquery
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', display_name, 'score', score)), '[]'::jsonb)
    INTO v_top5
    FROM (
      SELECT display_name, score FROM (
        SELECT DISTINCT ON (user_id) user_id, display_name, score
          FROM public.game_scores
         WHERE game = 'invader'
         ORDER BY user_id, score DESC
      ) per_user
      ORDER BY score DESC
      LIMIT 5
    ) ranked;

  RETURN jsonb_build_object(
    'myBest', v_my_best,
    'globalBest', v_global_best,
    'myRank', v_my_rank,
    'top5', v_top5
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_invader_stats() TO authenticated;