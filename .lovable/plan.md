## What's happening

Robert O'Koniewski's email (`rokoniewski@msada.org`, gmail id `19e6a1455025344d`) is in your Gmail inbox but missing from the Zerrow inbox.

DB row state right now:
- `is_archived = false`
- `classified_by = "manual_inbox"`, reason `"Moved to Inbox manually"`
- `raw_labels = {UNREAD, CATEGORY_PERSONAL}` — **`INBOX` is missing**

The Zerrow inbox view filters with `raw_labels @> ['INBOX']`, so this row is hidden even though `is_archived` is false.

## Why it ended up like this

When the email arrived at 11:36, `process-message` classified it into a folder with `auto_archive`/`hide_from_inbox` and stripped `INBOX` from local `raw_labels` (the intended behavior). When you then added the always-inbox override at 11:47, two things happened:

1. The "Move to Inbox" action ran `moveEmailToInbox` — that path now correctly re-adds `INBOX` locally (fixed last turn).
2. `addInboxOverride` ran with `reprocess_past = true`. Its reprocess loop only does:
   - `folder_id = null`
   - `classified_by = 'global_exclude'`
   - clears `matched_filter_ids` and `ai_summary`
   
   It does **not** set `is_archived = false` and does **not** add `INBOX` to `raw_labels`. So when the override reprocess runs against rows that arrived already archived/labeled by a folder, those rows stay hidden from the Zerrow inbox even after the override matches them. This is the same class of bug we hit twice already, just on the "always-inbox" entry point instead of "move to inbox".

A subsequent reconcile or label-sync event likely re-pulled Gmail labels for this row (or one of the two writers ran in the wrong order), which is how a row ended up with `classified_by = "manual_inbox"` but no `INBOX` in `raw_labels`.

## Fix

### 1. Update `addInboxOverride` reprocess loop (`src/lib/gmail.functions.ts` ~1605–1665)

For each matched row in the reprocess pass:
- Read `raw_labels` along with the other selected columns.
- Set `is_archived = false`.
- Compute `nextLabels = unique(currentLabels.filter(l => l !== oldFolderLabel).concat(["INBOX"]))` and write it back.
- Keep the existing Gmail-side `modifyMessage` call, but extend it to also add `INBOX` (currently it only removes the folder label).
- Change `classified_by` to `"inbox_override"` and `classification_reason` to `'Always-inbox: {match_type} "{value}"'` so the row's state matches the runtime override path in `process-message.ts`.

### 2. Targeted data repair (one row)

```sql
UPDATE public.emails
SET is_archived = false,
    raw_labels = (
      SELECT array_agg(DISTINCT l)
      FROM unnest(coalesce(raw_labels, ARRAY[]::text[]) || ARRAY['INBOX']) AS l
    )
WHERE gmail_message_id = '19e6a1455025344d';
```

No bulk backfill — we've been bitten by those before. Only this one row.

### 3. Validate

Re-query the row and confirm `INBOX` is in `raw_labels` and `is_archived = false`, then confirm the email appears in the Zerrow inbox view.

## Out of scope

- Not changing the inbox view filter.
- Not changing `moveEmailToInbox` (already correct).
- Not touching `process-message.ts` runtime path (already correct for new arrivals matching an override).
