## Problem

"Add contact from email" (and the bulk inbox import) calls `supabase.from("contacts").upsert(..., { onConflict: "user_id,email" })`, but the `contacts` table only has a primary key on `id` — no unique constraint on `(user_id, email)`. Postgres rejects the upsert with:

> there is no unique or exclusion constraint matching the ON CONFLICT specification

## Fix

One migration:

1. Deduplicate any existing rows with the same `(user_id, lower(email))` — keep the oldest, delete the rest (and their `contact_group_members` cascade).
2. Add `CREATE UNIQUE INDEX contacts_user_email_key ON public.contacts (user_id, email)` so `onConflict: "user_id,email"` resolves.
3. Add a partial index / handle `NULL` emails: rows with `email IS NULL` (manual entries, scanned cards without email) should not collide — a plain unique index already allows multiple NULLs, so this is fine.

No code changes needed; the existing `addContactFromEmail`, `buildContactsFromInbox`, and scan flows already pass the right `onConflict` key.

## Out of scope

- Changing the upsert keys or contact schema
- Touching `contact_groups` (already has its own unique index)
