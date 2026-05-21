# Add sublabel support to "New folder"

Gmail represents nested labels by putting `/` in the label name (e.g. `Zerrow/Newsletters/Promotions` is "Promotions" under "Newsletters" under "Zerrow"). Today `createGmailLabel` always creates a top-level `Zerrow/<name>` label, and the New Folder dialog has no way to say "this should live under another label."

## What changes (user-facing)

In the **New folder** dialog (`AddFolderDialog`), when the user picks **"Create new Gmail label"**, show one extra control:

- **Parent label** dropdown
  - Default: `None (top level)` → behaves exactly like today, creates `Zerrow/<name>`.
  - Other options: every existing user label under `Zerrow/…` (the same `labels` list already passed into the dialog), shown with their nested path so the user can see the hierarchy (e.g. `Zerrow / Newsletters`, `Zerrow / Newsletters / Promotions`).
  - Hidden when the user chose "Link to: <existing label>" (parent only applies to newly-created labels).

On submit, if a parent is selected, the new Gmail label is created as `<parent full name>/<new name>` (e.g. `Zerrow/Newsletters/Promotions`). Otherwise it stays `Zerrow/<new name>`.

The local `folders` row stores the resulting `gmail_label_id` exactly as today — no schema change.

## What changes (technical)

1. **`src/lib/gmail.functions.ts` → `createGmailLabel`**
   - Add optional `parent_label_id: string` to the input validator.
   - In the handler, when `parent_label_id` is provided, look up that label in `listLabels(...)`, verify its name starts with `Zerrow/` (so we only nest inside our own namespace), and build the full name as `${parent.name}/${data.name}`. Otherwise keep the existing `Zerrow/${data.name}`.
   - Reuse the existing "label already exists → return its id" short-circuit against the computed full name.

2. **`src/components/folders/AddFolderDialog.tsx`**
   - Add `parentLabelId` state (default `""` = none).
   - Render a second `<Select>` directly under the existing one, shown only when `labelChoice === NEW_LABEL`.
   - Populate options from the `labels` prop, filtered to names starting with `Zerrow/`, sorted alphabetically, with the display formatted as the path after `Zerrow/` joined by ` / ` (e.g. `Newsletters / Promotions`). Include a `None (top level)` option at the top.
   - Pass `parent_label_id` to `createLabel({ data: { account_id, name, parent_label_id } })` when set.
   - Reset `parentLabelId` alongside `name` / `labelChoice` after a successful create.

3. No DB migration, no changes to `FolderEditor` / `EditFolderDialog` (rename/move of existing labels is out of scope for this request).

## Out of scope

- Renaming or re-parenting an existing Gmail label.
- Auto-creating intermediate parents that don't exist yet (the dropdown only lists labels that already exist, so this can't happen).
- Showing the nested hierarchy elsewhere in the app's folder sidebar.
