## Why Google shows 390 vs Zerrow's 487, and wrong labels

Confirmed against the live DB:

1. **Google Contacts flat count (390) is the `myContacts` system group.** The People API only counts a person in Google's default "Contacts" screen if they're a member of `contactGroups/myContacts`. Zerrow's `createPerson` currently pushes only the user-defined label memberships (Factory, Vendor, etc.) and never adds `myContacts`, so every contact we create in Google lands in "Other contacts" and is invisible on that screen. That accounts for the ~97-contact gap.

2. **Labels are flat in Google, and we push the leaf name only.** The DB has real nesting (`Factory` → `Ford, GM, Honda, Hyundai, Kia, Nissan, Stellantis, Toyota, VW`), but Google Contacts has no label hierarchy. `pushGroups` sends just `g.name`, so Google shows a top-level "VW" next to the pre-existing OEM labels rather than "Factory - VW".

3. **Duplicate `Factory` local group** (one linked, one with no `google_group_links` row and 1 member) is a leftover that will cause a second flat "Factory" to appear in Google on the next push.

## Changes

### 1. Add every pushed contact to `myContacts` (fixes count)
`src/lib/google-contacts/push.server.ts`
- In `pushContacts`, always append `"contactGroups/myContacts"` to `memberResourceNames` before calling `contactToPerson` for both create and update paths. The People API accepts it as a normal membership.
- In `pushGroupMemberships`, when computing the `desired` set for a group, additionally reconcile `myContacts` for every linked contact so previously-created "Other contacts" get promoted on the next sync (one extra `members:modify` per run against `contactGroups/myContacts`).

### 2. Flatten nested labels as `"Parent - Child"` in Google
`src/lib/google-contacts/push.server.ts` (`pushGroups`)
- When loading `contact_groups`, also select `parent_group_id`.
- Resolve parent names into a map, and push the Google label name as `${parent.name} - ${g.name}` when `parent_group_id` is set (e.g. `Factory - VW`, `Vendor - Software`). Top-level groups keep their bare name.
- On rename of either parent or child, `updated_at` bump already triggers `updateContactGroup`, so the Google label auto-renames.

### 3. Clean up the duplicate local `Factory` group
- One-shot migration merges the orphan `Factory` (no `google_group_links` row, 1 member) into the linked `Factory` group by moving `contact_group_members` and deleting the orphan.

### 4. Backfill so the fix is visible immediately
- Migration flips `google_contact_links.last_synced_at = epoch` for all rows so the next sync re-pushes every linked contact with the new `myContacts` membership.
- Migration bumps `contact_groups.updated_at = now()` for every row with a `parent_group_id` so parent-prefixed labels get renamed in Google on the next push.

### 5. Settings UI copy
`src/routes/_authenticated/settings.google-contacts.tsx`
- Under two-way mode, add a one-line note: "Google Contacts doesn't support nested labels — subgroups sync as `Parent - Child` (e.g. Factory - VW). All Zerrow contacts are added to Google's default Contacts list."

### 6. Tests
`src/lib/google-contacts/push.test.ts` (new)
- Unit tests for the label-flattening helper (top-level unchanged, one level nested formatted as `Parent - Child`, missing parent falls back to leaf name).
- Assert `myContacts` is always included in the memberships passed to `contactToPerson`.

## Out of scope
- Deeper hierarchies (Google is fundamentally flat; we only concatenate one level, matching the current UI which uses one level of nesting).
- Any changes to CardDAV / iOS behavior — iOS handles nested groups natively and is untouched.
