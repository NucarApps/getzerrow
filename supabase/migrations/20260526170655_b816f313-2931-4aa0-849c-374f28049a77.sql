
ALTER TABLE public.game_scores
  ADD COLUMN IF NOT EXISTS level integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS kills integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_combo integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duration_ms integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_seed text,
  ADD COLUMN IF NOT EXISTS achievements text[] NOT NULL DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS game_scores_daily_idx
  ON public.game_scores (game, daily_seed, score DESC)
  WHERE daily_seed IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_invader_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_my_best int;
  v_global_best int;
  v_my_rank int;
  v_top5 jsonb;
  v_my_kills bigint;
  v_my_best_combo int;
  v_my_plays bigint;
  v_daily_seed text := to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD');
  v_my_daily_best int;
  v_daily_top5 jsonb;
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

  SELECT
    COALESCE(SUM(kills), 0),
    COALESCE(MAX(max_combo), 0),
    COUNT(*)
  INTO v_my_kills, v_my_best_combo, v_my_plays
  FROM public.game_scores
  WHERE game = 'invader' AND user_id = v_uid;

  SELECT MAX(score) INTO v_my_daily_best
    FROM public.game_scores
   WHERE game = 'invader' AND user_id = v_uid AND daily_seed = v_daily_seed;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', display_name, 'score', score)), '[]'::jsonb)
    INTO v_daily_top5
    FROM (
      SELECT display_name, score FROM (
        SELECT DISTINCT ON (user_id) user_id, display_name, score
          FROM public.game_scores
         WHERE game = 'invader' AND daily_seed = v_daily_seed
         ORDER BY user_id, score DESC
      ) per_user
      ORDER BY score DESC
      LIMIT 5
    ) ranked;

  RETURN jsonb_build_object(
    'myBest', v_my_best,
    'globalBest', v_global_best,
    'myRank', v_my_rank,
    'top5', v_top5,
    'myKills', v_my_kills,
    'myBestCombo', v_my_best_combo,
    'myPlays', v_my_plays,
    'dailySeed', v_daily_seed,
    'myDailyBest', v_my_daily_best,
    'dailyTop5', v_daily_top5
  );
END;
$function$;
