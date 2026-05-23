## Plan

1. **Add "starts with" and "ends with" filter operators**
   - In `src/components/folders/FolderEditor.tsx`, extend both filter-op selectors with `starts_with` and `ends_with` options:
     - The simple "Add filter" row (around line 552, `OP` Select).
     - The advanced rule-tree `OP_OPTS` array (around line 1224) — already used by `RuleNodeEditor`.
   - In `src/lib/sync.server.ts` (around line 71), extend the `applyFilter` switch to handle:
     - `starts_with` → `fieldVal.startsWith(v)`
     - `ends_with` → `fieldVal.endsWith(v)`
   - The client-side matcher in `src/routes/_authenticated/inbox.tsx` already understands these two ops, so no change needed there.

2. **Make the Edit Folder sheet mobile responsive**
   - Sheet width is already `w-full sm:max-w-xl`, so the container is fine. The problems are inside `FolderEditor`:
     - **Header row** (color + name + priority + menu, line 271): on a 402px viewport the priority `Input` (`w-20`) plus the name input squeezes everything. Switch to a wrap-friendly layout — color + name on row one, priority + menu on row two on mobile; single row on `sm:` and up.
     - **Filter add row** (line 537): two `Select`s (`w-32`, `w-36`) + `Input` + Button overflow on mobile. Make it stack: `flex-col sm:flex-row`, selects become `w-full sm:w-32 / sm:w-36`, button full-width on mobile.
     - **Existing filter chips** (line 519-534): allow wrapping (`flex-wrap`) so long values don't push the remove button off-screen; let the value span shrink with `min-w-0 break-all`.
     - **RuleNodeEditor cond row** (line 1245): same treatment — stack on mobile (`flex-col sm:flex-row`), full-width inputs, remove button aligns to the end.
     - **Learned-profile header** (line 312): the "Sync to Gmail" + "Re-learn" buttons sit beside the label and overflow on mobile. Stack the title above the buttons on mobile and let the buttons wrap.
     - **Suggested-domain chips** (line 336): already `flex-wrap`, but verify the popover trigger stays tappable; no change expected.
   - All changes are presentation-only Tailwind class adjustments; no behavior changes.

3. **Verify**
   - On the 402×716 mobile preview, open a folder for editing and confirm:
     - Nothing overflows horizontally; no horizontal scroll on the sheet.
     - Filter add row stacks cleanly; "starts with" and "ends with" appear in both the simple and advanced op pickers.
     - Adding a `starts with` / `ends with` filter routes a matching email correctly (server matcher updated).
   - On desktop, confirm the layout is visually unchanged.

## Technical notes

- Files touched:
  - `src/components/folders/FolderEditor.tsx` — add two `SelectItem`s in the simple op Select, two entries to `OP_OPTS`, and responsive Tailwind classes on the header / filter-add / chip / rule-node rows.
  - `src/lib/sync.server.ts` — two new `case` branches in `applyFilter`.
- No schema migration needed: `folder_filters.op` is already a free-form text column accepting any operator string, and rule-tree filters are stored in `filter_tree` JSON.
- `EXCLUDE_OPS` in `sync.server.ts` does not need updating — `starts_with`/`ends_with` are inclusive matchers.