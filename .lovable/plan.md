## Plan: Exceptions for "Always send to inbox" overrides

Add a way to say "everything from nucar.com goes to inbox, EXCEPT when subject starts with 'RE: Daily Reports'" — and also let high-priority folders override the inbox rule.

### 1. Schema: per-override exceptions

New table `inbox_override_exceptions` (1 override → many exceptions):
- `override_id` → `inbox_overrides.id` (cascade delete)
- `user_id` (RLS)
- `field` — `from`, `to`, `subject`, `body`, `snippet`
- `op` — `contains`, `equals`, `starts_with`, `ends_with`, `regex`
- `value` — text
- RLS: owner-only via `user_id`.

Why a separate table (not JSON on the override row): matches how `folder_filters` already works, easy to edit one row at a time, and the matcher in `sync.server.ts` already has a `field/op/value` evaluator we can reuse.

### 2. Schema: per-folder "beats inbox override" flag

Add `folders.overrides_inbox_override boolean default false`.
When true and that folder's filters match an email, the folder wins even if an inbox override matched the sender. Implemented as a simple priority swap in the classifier — no new evaluator.

### 3. Classifier change (`src/lib/sync.server.ts`)

Around line 303–315 (the `overrideHit` block):
1. Compute `overrideHit` as today.
2. Also compute the matching folder via the existing filter loop (currently runs after the override check — move it up so we know both results).
3. Decision:
   - If `overrideHit` AND any matched folder has `overrides_inbox_override=true` → folder wins.
   - Else if `overrideHit` AND no exception matches → inbox wins (current behavior).
   - Else if `overrideHit` AND an exception matches → fall through to normal folder/AI classification.
   - Else → current behavior.
4. Exception matcher reuses the same `applyFilter` switch (`contains`/`equals`/`starts_with`/`ends_with`/`regex`) already used by folder filters — so the two systems stay in sync (this is the same switch we just extended with `starts_with`/`ends_with`).
5. Extend `loadAccountContext` to also `select` exceptions joined by `override_id`, and include them in the cached `AccountContext`.

### 4. UI: `src/components/settings/InboxOverrides.tsx`

Each override row becomes expandable:
- Chevron toggles an "Exceptions" panel under the row.
- Inside: a list of existing exceptions (field + op + value + remove) and an "Add exception" row with three pickers + value input + Add button — same shape as the folder filter add row, including the new `starts_with`/`ends_with` ops.
- Empty state: "No exceptions — every email from nucar.com goes to inbox."
- Helper text on the override: "Add an exception to let some emails be sorted normally (e.g. subject starts with 'RE: Daily Reports')."

### 5. UI: `src/components/folders/FolderEditor.tsx`

Add a single Switch in the folder's options area (near `hide_from_inbox` / `auto_archive`):
- Label: **"Beat 'Always send to inbox' rules"**
- Helper: "When this folder's filters match, route the email here even if the sender is on your Always-send-to-inbox list."
- Wired to `folders.overrides_inbox_override`.

### 6. Verify

- Add nucar.com override → email from nucar arrives → goes to inbox. ✅ unchanged.
- Add exception `subject starts_with "RE: Daily Reports"` → matching email is sorted by folders/AI; non-matching still goes to inbox.
- Create a folder with filter `from contains nucar.com` + toggle "Beat inbox rules" on → all nucar mail goes to that folder, regardless of override.
- Without the toggle, the same folder loses to the override (current behavior).

### Technical notes

- Files touched:
  - migration: create `inbox_override_exceptions`, add `folders.overrides_inbox_override`.
  - `src/lib/sync.server.ts` — extend `AccountContext`, `loadAccountContext`, and the override branch in `classifyParsedEmail`. Reuse `applyFilter`.
  - `src/components/settings/InboxOverrides.tsx` — expandable exceptions UI.
  - `src/components/folders/FolderEditor.tsx` — new Switch row bound to `overrides_inbox_override`.
- No types regeneration needed beyond the standard auto-update after the migration.
- Default values keep behavior identical for existing users (no exceptions, flag off).