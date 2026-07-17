## Goal
Two additions to the Contacts page:
1. **Nested groups** (subgroups under a parent group) with a collapsible tree in the sidebar and filter-by-group that includes descendants.
2. **Bulk multi-select** on the "Ungrouped" view (and any group view) with a one-click "Add to group(s)" action.

---

## 1. Nested contact groups (subfolders)

### Data
- Add `parent_group_id uuid null` self-FK to `contact_groups` (`on delete set null`) plus an index. No CHECK for cycles — enforce in the server fn.
- `listContactGroups` returns `parent_group_id`; UI builds the tree client-side.
- `createContactGroup` / `updateContactGroup` accept optional `parent_group_id`, reject cycles and self-parenting, cap depth at 4 to keep the sidebar sane.
- Filtering by a parent group includes contacts in any descendant group (computed client-side from the tree + membership map already in memory).

### CardDAV round-trip
Apple `KIND:group` vCards are flat — there is no nested-group field. To keep iOS syncing cleanly:
- Serialize a nested group's `FN`/`N` as the path (`Clients / VIPs`) so the hierarchy is visible on iPhone as one flat group per node.
- Keep `carddav_uid` stable across renames/reparents so incremental sync keeps working.
- On PUT from iOS, treat any group name change the same as before (no attempt to parse `/` back into a parent — iOS-created groups stay top-level; users move them in Zerrow).
- No change to `sender_in_group` filter semantics — the filter still matches direct membership only; a follow-up can add "include subgroups" if wanted.

### UI (`src/routes/_authenticated/contacts.index.tsx`)
- Sidebar renders groups as a tree with chevrons for collapse/expand; drag-free for v1.
- `GroupEditorDialog` adds a "Parent group" native `<select>` populated from existing groups (excluding self + descendants).
- Filter chip for a parent shows aggregated descendant count.

---

## 2. Bulk multi-select + add-to-group

### Server
- New `addContactsToGroups({ contact_ids: string[], group_ids: string[] })` server fn under `contact-groups.functions.ts` that upserts into `contact_group_members` (`on conflict do nothing`) in a single batch, RLS via `requireSupabaseAuth`. Returns `{ added: number }`.
- (Companion) `removeContactsFromGroup({ contact_ids, group_id })` for the "Remove from group" action when viewing a specific group.

### UI
- Add a selection mode toggle on the contacts list header ("Select"). While active:
  - Row-level checkboxes replace the leading avatar hover state.
  - A sticky action bar shows `N selected`, `Add to group…`, `Clear`.
  - `Add to group…` opens a small popover with a search input + checkbox list of all groups (with nesting indent), plus a "Create new group…" shortcut that reuses `GroupEditorDialog` and pre-fills the selection.
- Selection state resets when `filter` changes or the list refetches.
- Works from any view (Ungrouped, All, or a specific group), so users can also reorganize contacts across groups in bulk.

---

## Files touched
- `supabase/migrations/*` — add `parent_group_id`, index.
- `src/lib/contact-groups.functions.ts` — parent field wiring, cycle guard, `addContactsToGroups`, `removeContactsFromGroup`.
- `src/lib/carddav/vcard.ts` — path-style `FN` for nested groups in `buildGroupVCard`.
- `src/lib/carddav/handlers.server.ts` — nothing structural; verify PUT handler still tolerates path-style names.
- `src/routes/_authenticated/contacts.index.tsx` — tree sidebar, descendant-aware filter, selection mode, bulk action bar, updated `GroupEditorDialog`.
- Small shared `GroupPickerPopover` component for the bulk action.

## Out of scope (call out if wanted later)
- Drag-and-drop reordering / reparenting in the sidebar.
- `sender_in_group` filter auto-including descendants.
- Nested representation over CardDAV beyond the name path.