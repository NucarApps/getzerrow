-- Restore missing table grants on user-facing public tables.
-- Cause: these tables ended up with no privileges for authenticated / service_role,
-- so PostgREST rejected all Data-API writes (RLS was fine). Only the folders
-- table is user-visible today because it's still written from the browser
-- client; the rest are covered as defense in depth since their writes all
-- flow through supabaseAdmin.
--
-- All listed tables are user-owned and scoped by auth.uid() = user_id in RLS,
-- so anon is intentionally not granted.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.folders          TO authenticated;
GRANT ALL                            ON public.folders          TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.emails           TO authenticated;
GRANT ALL                            ON public.emails           TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts         TO authenticated;
GRANT ALL                            ON public.contacts         TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companies        TO authenticated;
GRANT ALL                            ON public.companies        TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks            TO authenticated;
GRANT ALL                            ON public.tasks            TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.meetings         TO authenticated;
GRANT ALL                            ON public.meetings         TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.message_jobs     TO authenticated;
GRANT ALL                            ON public.message_jobs     TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.folder_examples  TO authenticated;
GRANT ALL                            ON public.folder_examples  TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.folder_filters   TO authenticated;
GRANT ALL                            ON public.folder_filters   TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbox_overrides  TO authenticated;
GRANT ALL                            ON public.inbox_overrides  TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.my_cards         TO authenticated;
GRANT ALL                            ON public.my_cards         TO service_role;