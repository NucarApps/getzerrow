# Fix: Folder doesn't empty when user removes its Gmail label

## What's happening

Tony emptied his Gmail "Factory" label, but Zerrow's Factory folder still shows those emails.

When Gmail removes a label from a message, our history-sync handler fires `applyLabelChange` → `computeLabelPatch`. That helper updates `raw_labels`, `is_archived`, and `is_read` — but it never touches `emails.folder_id`. Zerrow's folder view filters by `folder_id = <folder>` (see `inbox.tsx` line 397/449), so the rows keep appearing under Factory even though their Gmail label is gone.

The mirror problem exists for `labelsAdded`: we record a folder-learning example, but we don't actually assign `folder_id` when Gmail adds a folder's label. So moving a message into a label inside Gmail also doesn't move it in Zerrow.

## Fix

In `src/lib/sync.server.ts`, inside the history walk where we already build the `labelToFolder` map (lines 894–895), extend `applyLabelChange` (or its call site at lines 921‑954) to also patch `folder_id`:

1. **labelsRemoved**: if any removed `labelIds` matches a `folder.gmail_label_id` AND that folder is the email's current `folder_id`, set `folder_id = null` and `classified_by = 'gmail_unlabeled'`. (Scope by current folder_id so removing an unrelated label doesn't clobber a different active assignment.)
2. **labelsAdded**: if an added label maps to a folder via `labelToFolder`, set `folder_id = <that folder.id>`, `classified_by = 'gmail_labeled'`, and respect the folder's `hide_from_inbox` / `auto_archive` to set `is_archived` consistent with the rest of the pipeline.

Implementation shape:
- Pass `labelToFolder` into `applyLabelChange` (or inline the folder lookup in the loop at 952‑954 and the existing labelsAdded loop at 921‑951).
- Read the email's current `folder_id` in the same `select` we already do at lines 934‑940 (just add the column) so we don't add a roundtrip.
- Extend the patch object built by `computeLabelPatch` with the new `folder_id` / `classified_by` / `is_archived` keys when applicable. Keep `computeLabelPatch` pure — pass folder context in.

Realtime already broadcasts `emails` UPDATEs and `use-email-realtime.ts` re-evaluates row membership per query key, so once `folder_id` is cleared, the row drops out of the Factory view automatically. No UI changes needed.

## Backfill for Tony's existing drift

One-off SQL to repair rows whose Gmail label is already gone but Zerrow still files under that folder:

```sql
UPDATE public.emails e
   SET folder_id = NULL,
       classified_by = 'gmail_unlabeled'
  FROM public.folders f
 WHERE e.folder_id = f.id
   AND f.gmail_label_id IS NOT NULL
   AND NOT (COALESCE(e.raw_labels, '{}') @> ARRAY[f.gmail_label_id]);
```

Run it as a migration so Tony's Factory folder empties immediately and the going-forward fix keeps it in sync.

## Out of scope

- Folder-learning examples already recorded for those messages stay put (they're historical signal).
- AI-classified rows whose Gmail label was never set won't be affected — they have no `gmail_label_id` to match.
