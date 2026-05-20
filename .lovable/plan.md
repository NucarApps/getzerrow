# Stop forcing stripped emails back into the inbox

## Problem

When you "strip folder label" from a sender, the affected emails reappear in **All inbox** even though they're archived in Gmail. The screen shows messages that are not in your Gmail inbox.

## Root cause

`stripFolderLabelPast` in `src/lib/gmail.functions.ts` (lines 1366–1376) unconditionally writes `is_archived: false` on every matched row, regardless of whether Gmail still has the `INBOX` label on that message. It also doesn't re-add `INBOX` in Gmail — so the local "All inbox" view shows the message, but Gmail itself has it archived.

A previous DB check confirmed ~71 of 73 messages in the affected user's All inbox have `classified_by = 'manual_strip'` and no `INBOX` in `raw_labels`.

## Fix

### 1. `src/lib/gmail.functions.ts` — `stripFolderLabelPast`

- Add `raw_labels` to the row select (line 1336).
- Replace the hardcoded `is_archived: false` with `is_archived: !(m.raw_labels ?? []).includes("INBOX")` so the local archived flag mirrors Gmail's actual state.

Result: stripping a folder label leaves Gmail-archived messages archived locally, and only keeps inbox-labeled messages in the app inbox.

### 2. One-time backfill migration

For existing rows where `classified_by = 'manual_strip'` and `INBOX` is not in `raw_labels`, set `is_archived = true`. This immediately removes the ~71 incorrectly-inbox'd messages from "All inbox" without waiting for a re-sync.

```sql
UPDATE emails
SET is_archived = true
WHERE classified_by = 'manual_strip'
  AND NOT (COALESCE(raw_labels, '{}') @> ARRAY['INBOX']);
```

## Out of scope

- No UI change.
- No change to the "All inbox" query.
- No change to manual "move to inbox" (which correctly re-adds `INBOX` in Gmail).
- No change to other classifiers.
