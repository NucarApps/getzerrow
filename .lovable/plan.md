## Right-click → "Always send to inbox" with past-email reprocess

Currently the right-click "Always send to inbox" submenu has two items:
- Just `e.from_addr`
- Anyone `@domain`

Both only add a row to `inbox_overrides`, so future mail bypasses folders, but anything already classified into a folder (e.g. Cold Email) stays put.

### UX

Turn each option into a sub-menu with two choices:

- **Just `jsmith@dcd.auto`**
  - Future emails only
  - Future + move past emails to Inbox
- **Anyone `@dcd.auto`**
  - Future emails only
  - Future + move past emails to Inbox

Toast after the "past" variant: `Moved N past emails to Inbox`.

### Server

Extend `addInboxOverride` in `src/lib/gmail.functions.ts` with an optional `reprocess_past: boolean` flag.

When `reprocess_past` is true, after the override is inserted (or even if `already` exists), in the same handler:

1. Select all `emails` for `context.userId` where:
   - `match_type === "email"`: `lower(from_addr) = value`
   - `match_type === "domain"`: `lower(from_addr)` ends with `@${value}`
   - `folder_id IS NOT NULL` (already in inbox → skip)
2. For each, in parallel-bounded batches (e.g. 5 at a time):
   - Look up the old folder's `gmail_label_id` (single `folders` query keyed by the set of `folder_id`s).
   - `update emails set folder_id = null, classified_by = 'global_exclude', classification_reason = 'Global inbox list: <type> "<value>"', matched_filter_ids = '{}', ai_summary = null` for that row.
   - Best-effort `modifyMessage(account_id, gmail_message_id, [], [oldLabel])` to strip the Gmail label so it doesn't re-pull into the folder on next sync. Wrap in `try/catch`, log failures, keep going.
3. Return `{ ok, value, match_type, already, reprocessed_count }`.

Domain filter SQL: `from_addr ILIKE '%@' || value` (safe — `value` is lowercased & sanitized in the handler).

### Client wiring

In `src/routes/_authenticated/index.tsx`:

- Replace each of the two `ContextMenuItem`s in the "Always send to inbox" block with a `ContextMenuSub` containing the two `ContextMenuItem` variants above.
- Both variants call `addOverrideFn`; the "past" variant passes `reprocess_past: true`.
- After success with `reprocess_past`, also invalidate `["emails"]` and `["emails-summary"]` and toast the count.

### Out of scope

- No bulk-reprocess UI in Settings (only the right-click flow).
- No undo button — relisting in Settings already lets the user delete the override, and they can manually move emails back via the existing Move-to-folder menu.
- No rate-limit/queue work; we cap concurrency at 5 in-handler, which is fine for the volumes here.
- Classifier order, reanalyze handler, and the existing "future only" path stay unchanged.
