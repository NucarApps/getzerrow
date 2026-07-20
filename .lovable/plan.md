## Problem

Deleting a contact or a label fails with:

> new row violates row-level security policy for table "google_contact_tombstones"

`google_contact_tombstones` has a `BEFORE DELETE` trigger on both `contacts` and `contact_groups` that inserts a tombstone row so the Google Contacts push worker can propagate the delete upstream. A prior migration (`20260719123000_…`) marked those trigger functions `SECURITY DEFINER` to avoid a "permission denied" error, but the table's RLS only exposes a `SELECT` policy — there is no `INSERT` policy at all, and Postgres still checks RLS `WITH CHECK` for the executing role (the definer role isn't `BYPASSRLS`). So every user-scoped delete of a contact or label is aborted.

## Fix

Add the missing INSERT policy (and matching grant) to `google_contact_tombstones` so the trigger's insert is accepted when the row belongs to the current user.

Migration (one file):

- `GRANT INSERT ON public.google_contact_tombstones TO authenticated;`
- `CREATE POLICY "Users insert their google tombstones" ON public.google_contact_tombstones FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);`

`auth.uid()` is preserved across `SECURITY DEFINER` (it reads the request JWT, not the role), so `user_id` populated by the trigger from `google_contact_links.user_id` matches the caller. Admin/service paths already bypass RLS and continue to work. No app code changes.

## Verification

- Delete a contact and a label from the UI — both succeed; a row appears in `google_contact_tombstones` for the linked Google resource.
- Deleting a contact with no Google link still succeeds (trigger inserts zero rows).
- Run the Supabase linter to confirm no new warnings.