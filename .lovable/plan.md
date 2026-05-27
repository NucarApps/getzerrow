## Fix: "Also archive past matches" does nothing when the rule already exists

### Problem
In `applyFilterRuleToPast` (`src/lib/gmail.functions.ts`), the SQL query excludes emails already in the target folder (`.neq("folder_id", to_folder_id)`), and the archive step only runs against `movedIds`. So when the user re-triggers the same rule (or the rule already moved everything previously), there are no "moved" rows and the archive checkbox is silently ignored — exactly what the user just saw ("Rule already routed to Cold Email", no archive).

### Change

**`src/lib/gmail.functions.ts` — `applyFilterRuleToPast`**

1. Split the row fetch into two passes when `archive` is true:
   - **Move pass** (unchanged): rows matching the rule that are NOT in the target folder → run `performMove` loop.
   - **Archive pass** (new): rows matching the rule that are currently `is_archived = false`, regardless of `folder_id`. Select `id, gmail_message_id, raw_labels`, dedupe, then call `batchModifyMessages(account_id, gmailIds, [], ["INBOX"])` and update each row to `is_archived: true` with `INBOX` stripped from `raw_labels` (same helper as today).
2. Keep the existing `try/catch + logError` around `batchModifyMessages`.
3. Return `{ moved, failed, archived }` where `archived` now reflects all rows we actually flipped to archived in this call (including ones that were already in the target folder from a prior run).
4. Cap the archive pass at the same `limit(500)` as the move pass to keep it bounded.

No schema changes, no UI changes — the drawer already passes `archive: archivePast` and surfaces `past.archived` in the toast, so the count will now appear correctly.

### Out of scope
- No changes to `FilterLikeThisDrawer.tsx`.
- No change to folder `auto_archive` behavior.
- No change to the `addFolderRule` "already" path — the existing toast wording stays; only the archive count will start showing.
