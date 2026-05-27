## Problem

When a message arrives without Gmail's `INBOX` label (e.g. a Gmail-side filter auto-archived it, or it was synced via backfill) but matches an Always-inbox override, classify sets `classified_by = "inbox_override"` — but `process-message` never re-adds the `INBOX` label. The row stays `is_archived=true` with no `INBOX` in `raw_labels`, so the Zerrow Inbox view (which filters by `raw_labels.includes("INBOX") AND is_archived=false`) hides it.

Confirmed in the DB: every Mark Zarif row has `classified_by="inbox_override"`, `classification_reason='Always-inbox: domain "nucar.com"'`, yet `is_archived=true` and `raw_labels` lacks `INBOX`.

## Fix

### 1. `src/lib/sync/process-message.ts` — enforce inbox on override match

After classify returns, if `c.classified_by === "inbox_override"` and `!inInbox`:
- Call `modifyMessage(accountId, gmailId, ["INBOX"], [])` to add the `INBOX` label in Gmail (best-effort, wrapped in try/catch with `logError("process_message.inbox_override_restore_failed", …)`).
- Patch the local row: `is_archived = false` and `raw_labels = [...(parsed.raw_labels ?? []), "INBOX"]` (deduped).

Place this branch alongside (mutually exclusive with) the existing `folder_id` side-effects block — when override wins, `folder_id` is null so the existing branch is skipped, and the new branch runs instead.

### 2. One-shot repair migration

Backfill the rows already stuck in this state:

```sql
UPDATE public.emails
SET is_archived = false,
    raw_labels = (
      SELECT array_agg(DISTINCT l)
      FROM unnest(coalesce(raw_labels, ARRAY[]::text[]) || ARRAY['INBOX']) AS l
    ),
    classification_reason = classification_reason || ' (restored to inbox)'
WHERE classified_by = 'inbox_override'
  AND is_archived = true
  AND NOT ('INBOX' = ANY(coalesce(raw_labels, ARRAY[]::text[])));
```

This only touches override-classified, archived rows missing INBOX — exactly the bug's footprint. It does not re-add the label in Gmail for historical rows (would be 1 API call per row × many rows); the next user action (or natural sync) reconciles. If desired we can layer Gmail-side restoration later, but the immediate visibility issue is fixed by the local patch.

## Out of scope

- No change to override exception logic, folder-beats-override logic, or AI classification.
- No change to the Inbox view filter (`raw_labels.includes("INBOX")`).
- No mass Gmail API call for historical rows in the repair migration.
