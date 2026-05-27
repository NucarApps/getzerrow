## Add "Also archive past matches" option to filter drawer

When "Future and past matches" is selected in `FilterLikeThisDrawer`, surface a checkbox to also archive (remove from inbox) the matched existing emails — in addition to moving them to the chosen folder.

### Changes

**`src/components/emails/FilterLikeThisDrawer.tsx`**
- Add `archivePast` state (default `false`), reset alongside `applyToPast` when the drawer opens.
- Below the "Future and past matches" radio (rendered only when `applyToPast === true`), show a shadcn `Checkbox` + label: "Also archive them (remove from inbox)" with a hint.
- Pass `archive: archivePast` into `applyPastFn`.
- Toast summary appends ` · N archived` when archive count > 0.

**`src/lib/gmail.functions.ts` — `applyFilterRuleToPast`**
- Extend input schema with optional `archive: boolean` (default `false`).
- After the existing per-row `performMove` loop, if `archive` is true and we have moved rows:
  - Fetch `gmail_message_id` + `raw_labels` for the successfully moved rows.
  - Call `batchModifyMessages(account_id, ids, [], ["INBOX"])` (wrap in try/catch + `logError`, same pattern as `applyFolderBehaviorRetroactive`).
  - Update DB rows: `is_archived: true` and strip `INBOX` from `raw_labels` via `removeLabelsFromCurrent` (per-row, mirroring the existing helper).
- Return `{ moved, failed, archived }`.

### Out of scope
- No new folder behaviors, no schema changes.
- Folder's own `auto_archive` setting is unchanged — this is a one-shot retro action scoped to the past-matches the user just acknowledged.