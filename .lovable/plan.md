## What's happening

The pencil on a company row (e.g. IG Burton) opens the **Company Aliases + Tags** dialog. It currently only pre-selects tags that were saved as *company-level assignments* (`company_group_assignments` row for that domain). Tags that a contact in the bucket already belongs to via individual membership, bulk-add, auto-company-subgroups, or Google labels are ignored — so the dialog looks empty even when the contacts clearly are in groups.

Verified with a query: IG Burton has 1 contact, 0 group memberships and 0 company assignments — but the same bug shows up for any company whose contacts were tagged individually.

## Fix

Edit **only** `src/components/contacts/CompanyAliasesDialog.tsx` (presentation logic; no server or DB changes):

1. Use the `memberships` array already returned by `listContactGroups` to compute, per group, how many contacts in this bucket are members (`3 / 5`).
2. Seed `selectedGroupIds` on open with the union of:
   - saved `company_group_assignments` for this primary domain (today's behavior), **plus**
   - any group where **every** contact in the bucket is already a member (fully-covered groups).
3. In each group chip, when there is partial coverage (`0 < n < N`), show a small `n/N` badge next to the group name so the user can see "some of these contacts are already tagged here". Fully-covered / selected chips keep the existing check state.
4. Update the helper copy under the chip row from "Tags apply to everyone in this company." to something like "Tags apply to all N contacts in this company. Partially-tagged groups show how many are already members."

Saving still calls `setCompanyGroups`, which materializes the tag onto every contact in the bucket — no behavior change on write.

## Out of scope

No changes to the contact detail drawer, no schema changes, no changes to `setCompanyGroups` or the assignments table.
