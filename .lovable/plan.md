## Goal

When Contacts is grouped (currently "By company"), let you select an entire bucket in one click and use the existing group-assignment popover to add every contact in that bucket to one or more groups.

## Changes

**`src/routes/_authenticated/contacts.index.tsx`**
- In `CompanyBucketHeader`, add a checkbox on the left of each bucket header, shown only when `selectionMode` is on.
- Checkbox state is tri-valued: unchecked / indeterminate (some selected) / checked (all in bucket selected), computed from `selectedIds` vs `bucket.contacts`.
- Clicking the checkbox toggles the whole bucket: if not fully selected → add every `contact.id` in the bucket to `selectedIds`; if fully selected → remove them.
- Clicking the checkbox does not toggle collapse (`stopPropagation`).
- The existing "Add to groups" `GroupPickerPopover` in the selection toolbar already writes via `addContactsToGroups(contactIds, groupIds)`, so no backend change — selecting a company bucket and hitting the popover applies the groups to every contact in it.
- Selecting a bucket in "By company" mode automatically enables `selectionMode` if it isn't on yet, so the first click on a bucket checkbox works without a separate "Select" toggle.

## Out of scope

- No new server functions or schema changes.
- Ungrouped / non-bucketed list view is unchanged (already supports per-row multi-select).
- Group hierarchy, CardDAV, and Google Contacts sync are untouched.
