# Fix: Reclassify doesn't move "always-inbox" emails out of folders

## The problem

Shawn Hanlon added an **always-send-to-inbox** domain override. When you reclassify emails that are currently sitting in the **Factory** folder, the classifier correctly decides they belong in the inbox — but they stay in Factory instead of moving.

## Root cause

The reclassify action (`reclassifyEmails` in `src/lib/gmail.functions.ts`) only updates an email when the classifier returns a *folder*. When an always-inbox override wins, the classifier intentionally returns **no folder** (inbox = "no folder") with `classified_by = "inbox_override"`.

The current guard is:

```text
if (result.folder_id && result.folder_id !== email.folder_id) { ...move... }
else { count as "unchanged" }
```

Because the inbox result has `folder_id = null`, the `result.folder_id &&` check is false, so the email is counted as "unchanged" and never leaves Factory. This is why reclassifying does nothing for overridden senders.

## The fix (one function)

In `reclassifyEmails`, add a branch that handles the "should go to inbox" outcome — i.e. the classifier returned `folder_id = null` with `classified_by = "inbox_override"` while the email is currently in a folder.

For that case, perform the same full inbox restore that the existing "Move to Inbox" action (`moveEmailToInbox`) already does, so the message actually shows up in the inbox view (which filters on the `INBOX` label + `is_archived = false`):

1. Look up the current folder's Gmail label.
2. Recompute `raw_labels`: drop the old folder label, add `INBOX`.
3. Update the email row: `folder_id = null`, `is_archived = false`, `classified_by = "inbox_override"`, `ai_confidence = 1`, `matched_filter_ids = []`, new `raw_labels`, and the classification reason.
4. Call `modifyMessage` to add `INBOX` and remove the old folder label in Gmail.
5. Count it as `routed`.

The existing folder-to-folder path stays exactly as-is. Emails that resolve to "no match"/"excluded" (also `folder_id = null`, but **not** `inbox_override`) are deliberately left untouched, so reclassify never yanks emails into the inbox unless an explicit always-inbox rule says so.

## Verification

- In Factory, select emails from the overridden domain and run Reclassify → they move to the inbox and disappear from Factory.
- Confirm in Gmail the message regains the `INBOX` label and loses the Factory label.
- Reclassifying emails that genuinely belong in a folder still routes folder-to-folder as before, and truly unmatched emails stay where they are.

## Technical notes

- Only `src/lib/gmail.functions.ts` (`reclassifyEmails`) changes. The classification logic in `src/lib/sync/classify.ts` is already correct and is not touched.
- The inbox-restore steps mirror `moveEmailToInbox` (same file) to stay consistent with how manual "Move to Inbox" already behaves.
