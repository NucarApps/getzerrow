## Feature: Auto company subgroups

Let any contact group be flagged so that each distinct **company** among its members becomes a child subgroup automatically. Toggle it on/off per group.

### UX

- In the group detail / group edit menu, add a switch: **"Auto-create company subgroups"**.
- When ON:
  - Scan every direct+nested contact in the group.
  - For each unique non-empty `contacts.company` value, ensure a child `contact_groups` row exists under this group (matched by `parent_group_id` + normalized name).
  - Add contacts to their matching company subgroup.
  - Keep them in the parent group too (so the parent still shows "all factory contacts").
  - Auto-created subgroups get a marker so we know we own them and can prune when a company disappears or the toggle flips off.
- When OFF: leave existing auto-subgroups in place but stop maintaining them, and offer a one-click "Remove auto subgroups" action on the toggle row.

### Data changes (one migration)

- `contact_groups.auto_company_subgroups boolean not null default false` — the toggle.
- `contact_groups.auto_generated_from_group_id uuid null references contact_groups(id) on delete cascade` — marks a subgroup as auto-created and points to its parent source. Used to safely list/prune only rows we own; user-created subgroups are untouched.
- Index on `(user_id, auto_generated_from_group_id)`.

### Server logic (`src/lib/contacts/auto-company-subgroups.functions.ts`)

- `setAutoCompanySubgroups({ groupId, enabled })` — flips the flag; if enabling, runs a reconcile immediately; if disabling, no destructive action.
- `reconcileAutoCompanySubgroups({ groupId })` — idempotent:
  1. Load members of `groupId` (include contacts nested via other subgroups? **no** — only direct members to keep behavior predictable; can revisit).
  2. Group by normalized `company` (trim, case-insensitive; ignore blank).
  3. Upsert a child group per company (`parent_group_id = groupId`, `auto_generated_from_group_id = groupId`, name = company as typed).
  4. Sync `contact_group_members` for each child to match its company's contact set (insert missing, delete extras that no longer match).
  5. Delete auto subgroups whose company no longer appears among members.
- `pruneAutoCompanySubgroups({ groupId })` — used by the "Remove auto subgroups" button; deletes all `contact_groups` where `auto_generated_from_group_id = groupId`.
- Trigger reconcile from `crud.functions.ts` when a contact's company changes or membership in a flagged group changes (best-effort, wrapped so failures don't break the primary write).

### UI wiring

- `src/routes/_authenticated/contacts.index.tsx` group sidebar: show child subgroups (already supported via `parent_group_id`), with a small "auto" badge on rows where `auto_generated_from_group_id` is set.
- Group settings drawer: the switch + a **"Re-scan now"** button + **"Remove auto subgroups"** (visible when flag is off but auto rows still exist).

### CardDAV / Google sync

- Auto subgroups are normal `contact_groups` rows, so they flow through existing CardDAV and Google Contacts sync unchanged. No sync-side changes needed.

### Out of scope

- No AI naming/merging of similar company strings — we rely on the existing `company_aliases` normalization already used elsewhere (will apply the same normalizer inside the reconcile step so "Acme Inc" and "Acme, Inc." collapse).
- Nested (grandchild) auto-subgrouping isn't part of this — the toggle only produces one level of company children under the flagged group.
