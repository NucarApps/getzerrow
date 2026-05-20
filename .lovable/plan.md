## Bug: AI-classified email shows "Moved here manually"

### Root cause

When `processGmailMessage` AI-classifies a new email and adds the folder's Gmail label via `modifyMessage`, Gmail emits a `labelsAdded` history event for that same label. On the next `syncSinceHistory` run, that event matches a folder and calls `recordManualMove`, which overwrites the row's `classified_by` from `"ai"` to `"manual_move"` and inserts a `folder_examples` row with `source: "manual_move"`. The History tab then shows the manual-move card instead of the AI reason.

### Fix

In `src/lib/sync.server.ts`, `recordManualMove`: before treating a `labelsAdded` event as a manual move, look up the existing email row. Skip the manual-move recording when the row already belongs to this folder AND was classified by us (`ai`, `filter`, `gmail_label`, `domain_rule`). Only genuine user/Gmail-side moves — where the row's `folder_id` is different from (or null vs.) the labeled folder — should be recorded as `manual_move`.

### Steps

1. In `recordManualMove`, first `select id, folder_id, classified_by` for `(gmail_message_id, gmail_account_id)`.
2. If `folder_id === folder.id` and `classified_by` is in `{ai, filter, gmail_label, domain_rule, manual_move}`, return early (no example insert, no row update, no re-learn counter bump).
3. Otherwise proceed with existing behavior (insert example, update row to `manual_move`, maybe re-learn).

### Out of scope

- Changing the History UI.
- Suppressing the labelsAdded echo at the Gmail level.
- Backfilling existing rows already mislabeled as `manual_move` (user can re-process or we can do a one-off later).
