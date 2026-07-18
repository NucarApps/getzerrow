## Goal
Make auto company subgroups behave as a truly derived, read-only projection of the parent group's members' `company` values. Editing a contact's company (e.g. cleaning "Hyundai North America" → "Hyundai America") should automatically collapse/rename/split the affected subgroups, and users should not be able to edit auto-generated subgroups directly.

## Changes

### 1. Reactively reconcile on company changes
Right now `reconcileIfAuto` only runs when membership changes. If a contact's `company` string is edited, no reconcile fires and subgroups drift.

Add a small helper in `src/lib/contacts/auto-company-subgroups.functions.ts`:

- `reconcileAutoParentsForContact(supabase, userId, contactId)` — finds every parent group where (a) the contact is a direct member and (b) `auto_company_subgroups = true`, then calls `reconcileAutoCompanySubgroupsImpl` on each. Wrapped in try/catch per-parent so a failure never blocks the primary write.

Trigger it from:

- `updateContact` in `src/lib/contacts/crud.functions.ts` — only when the payload includes `company` (or when `name` changes and no company is set, since display can shift). Runs after the update succeeds.
- `bulkUpdateContacts` / merge paths in `src/lib/contacts/` (dedup merge, alias merge). Any code path that mutates `contacts.company` calls the helper for the merged/kept contact ids.
- Google Contacts pull (`src/lib/google-contacts/pull.server.ts`) after a batch, batched by touched contact id (deduped set → one call per parent group).

### 2. Loosen the group key to match the app's normalizer
Reuse `normalizeCompanyName` from `src/lib/contacts/company-name.ts` (already used for the merge-suggestion banner) instead of the local `companyKey` lowercaser. This way "Hyundai America", "Hyundai America, Inc.", "Hyundai America LLC" collapse into one subgroup automatically. The display name for the subgroup uses the most frequent raw variant among its members (tie → longest → alphabetical) so the label reads naturally.

### 3. Lock auto-generated subgroups in the UI
In `src/routes/_authenticated/contacts.index.tsx`:

- In the groups sidebar row: when `group.auto_generated_from_group_id` is set, hide the rename / color / delete / drag-reparent affordances and render a small lock icon with tooltip "Auto-generated from {parent name}. Edit the parent group's contacts to change this."
- In `GroupEditorDialog` (line 1092): if opened against an auto-generated group, render a read-only view (name + parent + member count + "Managed automatically" note) instead of the editable form. No save button.
- Server-side guard in `contact-groups.functions.ts` for `updateContactGroup` / `deleteContactGroup` / `addContactsToGroup` / `removeContactsFromGroup`: reject with "This subgroup is managed automatically" when the target has `auto_generated_from_group_id` set. Deletion is only allowed through the parent's toggle-off / prune path.

### 4. Small UX affordance
On the parent group row, keep the existing "Re-scan now" button but also surface a subtle "Updated Xs ago" so the user sees that subgroups are live. No new tables, no schema changes.

## Files touched
- `src/lib/contacts/auto-company-subgroups.functions.ts` — new helper, switch to `normalizeCompanyName`, display-name picker.
- `src/lib/contacts/crud.functions.ts` — trigger reconcile on company/name change.
- `src/lib/contacts/` merge/dedup functions — trigger reconcile after merges.
- `src/lib/google-contacts/pull.server.ts` — batched trigger after import.
- `src/lib/contact-groups.functions.ts` — server-side write guards.
- `src/routes/_authenticated/contacts.index.tsx` — sidebar lock UI + read-only editor branch.

## Out of scope
- No schema migrations.
- No changes to CardDAV group-display-style logic.
- No changes to Google Contacts group push mapping.
