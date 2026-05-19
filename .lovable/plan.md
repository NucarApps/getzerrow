# Fix: Gmail archive / read / trash changes don't propagate to the app

## Root cause

`syncSinceHistory` in `src/lib/sync.server.ts` processes only two kinds of Gmail history events:

1. `messagesAdded` → `processGmailMessage` (insert new email)
2. `labelsAdded` → records a manual move when a folder-linked label is added

It **ignores**:
- `labelsRemoved` (Gmail's archive = INBOX removed; mark-as-read = UNREAD removed)
- `messagesDeleted` (permanently deleted in Gmail)
- Trash (`labelsAdded: ["TRASH"]`)

So when you archive a message in Gmail, the next resync sees the history event but does nothing — the row in `emails` keeps `is_archived=false` and `raw_labels` still includes `INBOX`, so the inbox view keeps showing it. Hitting "Resync now" loops the same history events and gets the same no-op.

## Fix

Extend `syncSinceHistory` so every label change and deletion in Gmail is mirrored locally. One pass over each `history[]` entry:

- **`labelsRemoved`** with `INBOX` → set `is_archived = true`, update `raw_labels`
- **`labelsRemoved`** with `UNREAD` → set `is_read = true`, update `raw_labels`
- **`labelsAdded`** with `TRASH` OR **`messagesDeleted`** → delete row from `emails`
- **`labelsAdded`** with `UNREAD` → set `is_read = false` (re-marked unread in Gmail)
- For any label change, update `raw_labels` to the current set on the event (Gmail includes the full `labelIds` array on each event's `message`)
- Keep existing `labelsAdded` → folder-linked-label manual-move learning (unchanged behavior)

All updates are scoped by `gmail_account_id + gmail_message_id` and are no-ops if the row doesn't exist locally (e.g. an old message we never ingested).

## Files touched

- `src/lib/sync.server.ts` — add a small helper `applyLabelChangesLocally(accountId, event)` and wire `labelsRemoved` + `messagesDeleted` branches into the `syncSinceHistory` loop.

## Verification

After the change, the user clicks **Resync now** once; the three already-archived emails will disappear from the inbox view because their `is_archived` flips to `true`. Going forward, every archive/read/trash done in Gmail propagates automatically on the next push or poll (≤ 2 min via the cron fallback we already set up).

## Notes

- No schema changes.
- Existing webhook path benefits automatically since the webhook also calls `syncSinceHistory`.
- This is purely a server-side fix; no UI work needed.
