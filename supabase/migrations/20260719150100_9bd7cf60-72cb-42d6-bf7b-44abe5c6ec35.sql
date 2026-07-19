-- Company-label dedup, phase 2: enforce one label per (user, parent scope,
-- normalized name).
--
-- Precondition: the consolidate-label-duplicates backfill hook (or the
-- user-facing Auto-merge) has already merged known duplicates via the full
-- app-level merge (which also handles alias-aware clusters the mild
-- name_key can't see). The DO block below is the DEFENSIVE residue merge —
-- byte-level name_key collisions only — so the unique index can never fail
-- to build. Loops because reparenting a loser's children under the keeper
-- can itself create a new collision in the keeper's scope.
--
-- The BEFORE DELETE tombstone triggers (google + carddav, see
-- 20260719150000) fire for every loser deleted here, so already-synced
-- iPhones/Google accounts drop the duplicates on their next sync.

DO $$
DECLARE
  zero constant uuid := '00000000-0000-0000-0000-000000000000';
  dup RECORD;
  keeper uuid;
  loser uuid;
  pass int := 0;
  merged_any boolean;
BEGIN
  LOOP
    pass := pass + 1;
    merged_any := false;

    FOR dup IN
      SELECT t.user_id,
             COALESCE(t.parent_group_id, zero) AS scope,
             t.name_key,
             array_agg(t.id ORDER BY t.member_count DESC, t.created_at ASC) AS ids
      FROM (
        SELECT g.id, g.user_id, g.parent_group_id, g.name_key, g.created_at,
               (SELECT count(*) FROM public.contact_group_members m
                 WHERE m.group_id = g.id) AS member_count
        FROM public.contact_groups g
        WHERE g.name_key IS NOT NULL
      ) t
      GROUP BY t.user_id, COALESCE(t.parent_group_id, zero), t.name_key
      HAVING count(*) > 1
    LOOP
      keeper := dup.ids[1];
      FOREACH loser IN ARRAY dup.ids[2:array_upper(dup.ids, 1)] LOOP
        merged_any := true;

        -- Move memberships; the (group_id, contact_id) PK dedupes overlap.
        INSERT INTO public.contact_group_members
            (group_id, contact_id, user_id, auto_added, source)
          SELECT keeper, m.contact_id, m.user_id, m.auto_added, m.source
          FROM public.contact_group_members m
          WHERE m.group_id = loser
          ON CONFLICT (group_id, contact_id) DO NOTHING;
        DELETE FROM public.contact_group_members WHERE group_id = loser;

        -- Reparent children and auto-subgroup provenance.
        UPDATE public.contact_groups
          SET parent_group_id = keeper WHERE parent_group_id = loser;
        UPDATE public.contact_groups
          SET auto_generated_from_group_id = keeper
          WHERE auto_generated_from_group_id = loser;

        -- Rules: drop would-be duplicates on the loser, then repoint.
        DELETE FROM public.contact_group_rules r
          WHERE r.group_id = loser
            AND EXISTS (SELECT 1 FROM public.contact_group_rules k
                         WHERE k.group_id = keeper
                           AND k.rule_type = r.rule_type
                           AND k.value = r.value);
        UPDATE public.contact_group_rules
          SET group_id = keeper WHERE group_id = loser;

        -- Google links: (gmail_account_id, contact_group_id) is unique —
        -- drop the loser's link when the keeper already has one for that
        -- account (the remote dup label stops spawning local dups).
        DELETE FROM public.google_group_links l
          WHERE l.contact_group_id = loser
            AND EXISTS (SELECT 1 FROM public.google_group_links k
                         WHERE k.contact_group_id = keeper
                           AND k.gmail_account_id = l.gmail_account_id);
        UPDATE public.google_group_links
          SET contact_group_id = keeper WHERE contact_group_id = loser;

        -- Suggestions, company linkage, folder filters follow the keeper.
        UPDATE public.contact_group_suggestions
          SET existing_group_id = keeper WHERE existing_group_id = loser;
        UPDATE public.contact_group_suggestions
          SET parent_group_id = keeper WHERE parent_group_id = loser;
        UPDATE public.companies
          SET linked_group_id = keeper WHERE linked_group_id = loser;
        UPDATE public.folder_filters
          SET value = keeper::text
          WHERE op = 'sender_in_group' AND value = loser::text;

        -- Tombstone triggers (google + carddav) fire here.
        DELETE FROM public.contact_groups WHERE id = loser;
      END LOOP;
    END LOOP;

    EXIT WHEN NOT merged_any OR pass >= 5;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS contact_groups_user_parent_name_key_uniq
  ON public.contact_groups (
    user_id,
    COALESCE(parent_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
    name_key
  )
  WHERE name_key IS NOT NULL;
