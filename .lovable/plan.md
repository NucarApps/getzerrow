## What's going on

For the **Notifications** folder, `auto_mark_read` is actually **`false`** in the database, even though you believe you turned it on. There are 9,286 emails in that folder and 112 are still unread in both Zerrow and Gmail — consistent with the toggle never being saved.

Two reasons this happens today:

1. **The toggles in `FolderEditor` only update local state.** Auto-archive, auto-mark-read, auto-star, hide-from-inbox, skip-AI, etc. don't persist until you scroll to the bottom and click **Save**. It's easy to flip a switch, leave the sheet, and assume it stuck. (For comparison, your other two folders with `auto_mark_read = true` — Orders 202/202 and Cold Email 857/857 — are working correctly: every email is read in our DB and `UNREAD` is gone from `raw_labels`.)

2. **Even when you do save, it only applies to *new* mail.** Existing emails in the folder stay unread in Gmail and in Zerrow until something new arrives that matches.

You wanted both: the toggle should stick, and turning it on should clean up what's already in the folder.

## Changes

### 1. Auto-save the per-folder behavior toggles (`src/components/folders/FolderEditor.tsx`)

Switch the behavior toggles from "edit local, save on button" to "save on change", so flipping the switch immediately writes to the database. Applies to:
- `auto_mark_read`
- `auto_archive`
- `auto_star`
- `hide_from_inbox`
- `skip_ai`
- `snooze_hours`, `min_ai_confidence`, `forward_to`, `priority` — keep on the Save button (these are not pure toggles)
- `name`, `color`, `ai_rule`, `filter_logic`, `filter_tree`, `gmail_label_id` — keep on the Save button

Add a tiny "Saved" indicator next to each toggle when it persists, and revert + toast on error. No more silent loss on toggle.

### 2. Retroactive apply when `auto_mark_read` flips on (new server function in `src/lib/gmail.functions.ts` + Gmail helper)

When the toggle turns on, run a one-shot pass on emails currently in that folder:

- **DB:** `update emails set is_read = true where folder_id = $1 and is_read = false and user_id = auth.uid()`.
- **Gmail:** call a new `batchModifyMessages(accountId, ids, [], ["UNREAD"])` helper that hits `POST /users/me/messages/batchModify` (up to 1000 ids per call, chunk as needed). Use the `gmail_message_id` of every row we just flipped.
- Fire-and-forget pattern (like the move-to-folder retrain), wrapped in try/catch so a Gmail hiccup doesn't fail the toggle. Surface a toast: `"Marked 112 existing emails as read"` on success.

Do the same shape for `auto_archive` / `hide_from_inbox` (remove `INBOX` + set `is_archived = true`) and `auto_star` (add `STARRED`) when those toggle on, so the retroactive contract is consistent across all per-folder switches.

### 3. No schema change

All the columns and the Gmail OAuth scopes we need already exist. No migration.

## Files touched

- `src/components/folders/FolderEditor.tsx` — switch the four/five boolean toggles to auto-save with an `onCheckedChange` that writes immediately.
- `src/lib/gmail.functions.ts` — new `applyFolderBehaviorRetroactive` server fn called from the toggle handlers, plus the toast feedback.
- `src/lib/gmail.server.ts` — add `batchModifyMessages(accountId, ids, addLabelIds, removeLabelIds)` thin wrapper around Gmail's `batchModify` endpoint.

## Out of scope

- Surfacing a "this folder has N unread" badge in the sidebar.
- Changing how `mark all read` works on the inbox toolbar (that's a different button).
- Re-running classification on existing emails when a folder's AI rule changes.

## Technical detail

Gmail `batchModify`:
```
POST https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify
{ "ids": [...up to 1000...], "removeLabelIds": ["UNREAD"] }
```
Returns 204 on success. We'll chunk in batches of 1000 and run them sequentially to stay under the 25 s per-server-fn budget; 9k emails ≈ 9 batches ≈ well under budget. For folders larger than ~20k unread we'll cap at the first 10k and queue the rest via a lightweight job — but no current folder is anywhere near that.
