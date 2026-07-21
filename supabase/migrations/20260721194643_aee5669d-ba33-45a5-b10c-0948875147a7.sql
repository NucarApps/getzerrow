-- Backfill: any folder with no user-authored intent (no AI rule, no filter
-- tree, no linked Gmail label) is inert. Previously these could be
-- created with skip_ai=false and immediately compete for AI routing.
UPDATE public.folders
SET skip_ai = true,
    min_ai_confidence = GREATEST(COALESCE(min_ai_confidence, 0), 0.75)
WHERE COALESCE(NULLIF(TRIM(ai_rule), ''), NULL) IS NULL
  AND filter_tree IS NULL
  AND gmail_label_id IS NULL
  AND (skip_ai IS DISTINCT FROM true OR COALESCE(min_ai_confidence, 0) < 0.75);

-- Also disqualify folders whose only intent is a Gmail label from AI
-- classification: label-linked folders mirror Gmail, they should not
-- also broadly compete for AI routing unless the user explicitly adds
-- an ai_rule.
UPDATE public.folders
SET skip_ai = true,
    min_ai_confidence = GREATEST(COALESCE(min_ai_confidence, 0), 0.75)
WHERE COALESCE(NULLIF(TRIM(ai_rule), ''), NULL) IS NULL
  AND filter_tree IS NULL
  AND gmail_label_id IS NOT NULL
  AND (skip_ai IS DISTINCT FROM true OR COALESCE(min_ai_confidence, 0) < 0.75);
