## Problem

Auto-company subgroups today only look at the parent group's **direct members**. When you enabled "Auto-create company subgroups" on Factory, it saw the 4 Nissan people that were already in Factory and made a Nissan subgroup with those 4. The other 3 contacts whose `company = "Nissan"` were never added to Factory, so they aren't in the auto subgroup either. The user's expected model: once Nissan is a represented company inside Factory, every contact with `company = Nissan` should be in Factory AND in the Nissan subgroup automatically.

## Fix

Make the parent group membership include an "auto" tier that mirrors every represented company, and rebuild reconcile on top of it.

### 1. Schema

Migration: add `auto_added boolean not null default false` to `public.contact_group_members`. Index `(group_id, auto_added)` for cheap filters. No RLS/grant changes (existing policy already covers the row).

### 2. `reconcileAutoCompanySubgroupsImpl` (rewrite)

For a parent group `P` with `auto_company_subgroups = true`:

1. Load direct members of `P` split by `auto_added`:
   - `manualIds` = members with `auto_added = false`
   - `autoIds` = members with `auto_added = true`
2. Load `company` for `manualIds` only → distinct `normalizeCompanyName` set = **represented companies** (`repKeys`). Manual members drive the set; auto members never do (prevents runaway expansion).
3. For each `key` in `repKeys`, fetch every user-owned contact whose `normalizeCompanyName(contacts.company)` matches. Do this in one query: pull `id, company` for all user contacts with non-null company (already indexed), normalize in JS, group by key. (Contacts table stays small enough per user; matches the pattern used elsewhere in `contacts.index.tsx`.)
4. **Parent membership reconcile**:
   - `wantedAutoIds` = union of all matched contact ids minus `manualIds` (never demote manual to auto).
   - Insert missing rows as `{ group_id: P, contact_id, user_id, auto_added: true }` with upsert `ignoreDuplicates`.
   - Delete rows in `P` where `auto_added = true` AND `contact_id NOT IN wantedAutoIds`.
5. **Subgroup reconcile** (existing logic, retargeted): each auto subgroup's member set = all contacts matching that key (manual + auto in parent are irrelevant here — the subgroup mirrors the full company).
6. Existing create/rename/delete of subgroup rows stays the same, driven by `repKeys`.

### 3. Trigger points

- `contact-groups.functions.ts` `addContactsToGroup` / `removeContactsFromGroup` / `bulkAdd`: keep calling `reconcileIfAuto`. Writes to `contact_group_members` from these paths must set `auto_added: false` explicitly (they represent user intent).
- `contacts/crud.functions.ts` company edits: `reconcileAutoParentsForContacts` currently only reconciles parents the contact is already a member of — which misses the exact case in the bug (contact isn't in Factory yet). Change it to:
  - Load every group with `auto_company_subgroups = true` for the user.
  - For each, run `reconcileAutoCompanySubgroupsImpl`. (Small N per user; acceptable. Same treatment as `renameCompanyForContacts` — that already calls this helper.)
- `google-contacts/pull.server.ts` already calls `reconcileAutoParentsForContacts` after pulls; it inherits the new behavior.

### 4. Data backfill

The migration also runs a one-shot reconcile: for every `contact_groups` row with `auto_company_subgroups = true`, invoke the new reconcile once so Factory (and any other user's existing auto groups) picks up the missing Nissan contacts immediately without waiting for the next edit. Implement as a plain server function `reconcileAllAutoGroups` that the settings UI can also expose later; run it once from a follow-up SQL-free path by calling it via `supabase--invoke`-style tool? Simpler: put a small `DO $$ ... $$` in the migration is not possible because reconcile is JS. Instead: on next app load, a one-time client trigger — no. Cleaner: expose `reconcileAllAutoGroups` server fn and call it once from the contacts page on mount when a `localStorage` flag isn't set. **Chosen approach**: add the server fn; call it once from `contacts.index.tsx` behind a `useEffect` that checks `localStorage.getItem("zerrow.auto-groups.backfilled.v1")`, sets it after success. Zero user action required, runs exactly once per browser.

### 5. UI

No visible UI changes beyond the automatic backfill toast ("Updated auto company groups"). The read-only lock on auto subgroups stays as-is. Auto-added parent memberships aren't visually distinguished (per user's mental model — "they should just be in Factory").

## Files

- `supabase/migrations/<new>.sql` — `ALTER TABLE contact_group_members ADD COLUMN auto_added ...` + index.
- `src/lib/contacts/auto-company-subgroups.functions.ts` — rewrite `reconcileAutoCompanySubgroupsImpl`, expand `reconcileAutoParentsForContacts`, add `reconcileAllAutoGroups` server fn.
- `src/lib/contact-groups.functions.ts` — set `auto_added: false` on all insert paths (add/bulk-add).
- `src/routes/_authenticated/contacts.index.tsx` — one-time backfill effect gated by `localStorage`.

## Out of scope

- No new column on `contact_groups`; represented-companies set is derived, not stored.
- No badge/UI to mark auto-added members inside the parent list (the point is they look identical to manual ones).
- Not touching CardDAV sync mapping — auto members export the same as manual ones through the existing pipeline.
