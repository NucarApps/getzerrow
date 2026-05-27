## Problem

The previous repair migration restored `INBOX` and `is_archived=false` on every historical row classified as `inbox_override`. That backfilled 3,747 old messages — many archived by Gmail or by the user long ago — back into the Zerrow inbox view, making it look like "all mail" instead of a curated inbox.

The runtime fix in `process-message.ts` (restore INBOX only for newly arrived override matches) is correct and should stay. The mistake was applying the same logic retroactively to history.

## Fix

### 1. Reversal migration

Undo only the rows the previous migration touched. They are uniquely identified by the suffix appended to `classification_reason`:

```sql
UPDATE public.emails
SET is_archived = true,
    raw_labels  = array_remove(raw_labels, 'INBOX'),
    classification_reason = regexp_replace(
      classification_reason, ' \(restored to inbox\)$', ''
    )
WHERE classification_reason LIKE '% (restored to inbox)';
```

No Gmail API calls. We do not strip the `INBOX` label in Gmail because the original Gmail state already had it removed — restoring the local row to "archived" simply matches Gmail again.

### 2. Keep the forward-looking behavior

Leave `src/lib/sync/process-message.ts` as is. New incoming messages that match an "Always-inbox" override and arrive without `INBOX` (Gmail-side filter) still get restored — both in Gmail and locally — at process time. That was the original Mark Zarif bug; the runtime fix solves it without dragging history along.

### Out of scope

- No changes to override matching, folder logic, AI classification, or the inbox view filter.
- No bulk Gmail API mutations on historical rows.
