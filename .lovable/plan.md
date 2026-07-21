# Fix silently-failing folder creation

## What's actually broken

Jared's "Kennect" folder was created in Zerrow on 2026-07-21. The Gmail label was created successfully, but no row exists in `public.folders` — for him or, in fact, for anyone since 2026-06-09.

Root cause: `public.folders` has **no `GRANT`s** for `anon`, `authenticated`, or `service_role`. PostgREST rejects the client-side insert in `AddFolderDialog.tsx` regardless of RLS. The rest of the app doesn't feel this because nearly every other write goes through `supabaseAdmin` (service role bypasses grants). Folder-create is one of the last remaining direct client writes.

The "emails going into Kennect that make no sense" that Jared sees is the Gmail label picking up mail via Gmail's own smart-label heuristics — Zerrow isn't classifying anything into it, because it doesn't know the folder exists.

Same missing-grants pattern is present on 10 other user tables, but they aren't user-visible today because all their writes go through server functions with `supabaseAdmin`. Grants are still worth restoring for defense in depth, but I'll keep that scoped.

## Changes

### 1. Migration: restore table grants + policy-scoped grants

One migration that adds the standard grant block to every user table currently missing it. All are `auth.uid() = user_id`-scoped, so no `anon` grants:

```
GRANT SELECT, INSERT, UPDATE, DELETE ON public.<t> TO authenticated;
GRANT ALL ON public.<t> TO service_role;
```

Tables covered: `folders`, `emails`, `contacts`, `companies`, `tasks`, `meetings`, `message_jobs`, `folder_examples`, `folder_filters`, `inbox_overrides`, `my_cards`.

This alone unblocks `AddFolderDialog` for every new signup, immediately.

### 2. Move folder-create to a server function (harden the write path)

`AddFolderDialog.tsx` doing a raw `supabase.from("folders").insert(...)` from the browser is inconsistent with the rest of the codebase and is what made this class of failure silent (a toast the user missed, no server-side log).

- Add `createFolder` in `src/lib/gmail/folder-mgmt.functions.ts`:
  - `createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])`
  - Zod input: `{ account_id, name, color, gmail_label_id? }`
  - Verifies `getOwnedAccount(userId, account_id)`.
  - Inserts via `supabaseAdmin` (owner is the authenticated user).
  - Returns `{ id }`.
- Update `AddFolderDialog.tsx`:
  - Replace the direct `supabase.from("folders").insert(...)` with `useServerFn(createFolder)`.
  - Keep the existing `createGmailLabel` → `createFolder` → `learnFolderFromLabel` sequence.
  - Any thrown error surfaces via toast (was already the pattern for the label call).

### 3. Restore Jared's Kennect folder

After the migration lands, insert the missing row for Jared (`user_id = e8fb5402-…`, his `gmail_account_id`), linked to the existing Kennect Gmail label id (I'll look up the label id from Gmail at apply-time using his account context), then enqueue `learnFromLinkedLabel` so previously-labeled mail is pulled into the folder and future mail is classified.

If I can't confirm the Gmail label id safely, I'll fall back to creating an unlinked folder and let him link the label in the UI.

## Out of scope

- No changes to RLS policies — they're already correct.
- No refactor of other user-visible write paths — none of them use the browser Supabase client for writes today.
- No security-linter follow-ups unrelated to grants.

## Technical details

- Migration file: `supabase/migrations/<ts>_restore_public_table_grants.sql` — pure `GRANT` statements, no schema changes.
- New server fn: `createFolder` in `src/lib/gmail/folder-mgmt.functions.ts`.
- Client edit: `src/components/folders/AddFolderDialog.tsx` — swap insert for server fn call; delete `supabase.auth.getUser()` (server fn has `context.userId`).
- Verification after apply:
  1. `SELECT count(*) FROM public.folders WHERE created_at > now() - interval '1 hour'` after re-running Jared's create.
  2. Watch `stack_modern--server-function-logs` for `createFolder` invocations.
  3. Confirm Jared's inbox starts showing rule/AI activity in `executed_rules` for Kennect.
