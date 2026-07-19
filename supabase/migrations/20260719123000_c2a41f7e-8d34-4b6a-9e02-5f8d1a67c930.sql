-- The google-tombstone trigger functions run BEFORE DELETE on
-- contacts/contact_groups and INSERT into google_contact_tombstones. That
-- table only grants SELECT to authenticated (and its RLS policy is
-- SELECT-only), and the functions were not SECURITY DEFINER — so the
-- trigger's INSERT ran with the end user's privileges and raised
-- "permission denied", aborting EVERY delete of a contact or label made
-- through the user-scoped client (Postgres checks the INSERT privilege
-- even when the trigger's SELECT matches zero rows). Admin-client paths
-- (CardDAV, webhooks) were unaffected, which masked the bug.
--
-- Run the trigger functions as their owner instead. Clients still cannot
-- write tombstones directly — table grants are unchanged.
ALTER FUNCTION public.record_google_contact_tombstone() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION public.record_google_group_tombstone() SECURITY DEFINER SET search_path = public;
