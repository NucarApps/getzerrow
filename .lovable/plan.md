## Goal

From the company edit dialog (pencil icon), let the user pick one or more existing tags/groups and apply them to every contact in that company.

## Backend

**New table** `public.company_group_assignments`:
- `user_id uuid`, `primary_domain text`, `group_id uuid`
- PK `(user_id, primary_domain, group_id)`
- RLS: `auth.uid() = user_id` for all ops.

**New server functions** in `src/lib/company-groups.functions.ts`:
- `listCompanyGroupAssignments()` → `{ primary_domain, group_id }[]` for current user.
- `setCompanyGroups({ primaryDomain, contactIds, groupIds })`:
  1. Upsert `company_group_assignments` to exactly match `groupIds` for this domain (delete missing, insert new).
  2. For every `contactId` in `contactIds`, add memberships for each selected `groupId` via idempotent upsert on `contact_group_members` (reuses existing pattern from `addContactsToGroup`). Does NOT remove a contact from a group that was deselected at the company level — individual contact-level group memberships stay intact.

The `contactIds` list is computed and sent from the client (it already knows which contacts are in the bucket, including merged aliases), so the server stays a thin RLS-scoped writer.

## Client

**`CompanyAliasesDialog`** — new "Tags" section above "Other domains":
- `useQuery(["company-group-assignments"])` and `useQuery(["contact-groups"])` (already cached).
- Render the user's groups as togglable chips (color dot + name). Pre-select chips matching saved assignments for this `primaryDomain`.
- Single "Save tags" button. On click: call `setCompanyGroups` with `primaryDomain`, the bucket's `contactIds`, and the selected `groupIds`. Toast `Tagged N contacts`. Invalidate `["company-group-assignments"]` and `["contact-groups"]` (memberships refresh the group dots on contacts).
- New prop on `CompanyAliasesDialog`: `contactIds: string[]` — wired from `contacts.index.tsx` using the bucket the user clicked.

**`contacts.index.tsx`**:
- Pass `contactIds={aliasDialog ? bucket.contacts.map(c => c.id) : []}` into the dialog (store the contact IDs alongside `domain` + `name` when opening the dialog).

## Behavior notes

- Re-opening the dialog later shows the previously selected groups; saving again re-materializes memberships, so any new contacts that landed in the company since last save get tagged.
- Removing a group at the company level only updates the saved assignment — it does NOT strip the group from contacts who already had it (whether company-applied or per-contact). Avoids accidental data loss.
- "Personal" buckets (no domain) don't show the Tags section.

## Out of scope

- Auto-tagging new contacts at email ingest time (would require hooking the contact-creation path in sync). The dialog re-save covers this manually.
- A separate "Remove tag from all" bulk action.
- Reordering/coloring of group chips inside the dialog.