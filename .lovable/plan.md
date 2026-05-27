# Fix: emails archived in Gmail still showing in Zerrow inbox

## Root cause

When Gmail archives a message, it sends a history event with `labelsRemoved: ["INBOX"]`. In `src/lib/sync.server.ts`, `applyLabelChange` handles it like this:

```ts
if (currentLabels) patch.raw_labels = currentLabels;
if (removed.includes("INBOX")) patch.is_archived = true;
```

`currentLabels` is the `message.labelIds` snapshot from the Gmail history payload, which still contains `"INBOX"` at the moment the event was emitted. So the local row ends up with `is_archived: true` AND `raw_labels` still containing `"INBOX"`.

The Inbox view (and sidebar unread count) decide membership using `raw_labels.includes("INBOX")` — matching Gmail's own semantics — so these rows keep showing up in the Zerrow inbox until reconcile eventually re-fetches the labels.

## Fix

1. **`src/lib/sync.server.ts` → `applyLabelChange`**: when computing `patch.raw_labels`, apply the `added` / `removed` arrays from the same history event so the stored labels match the post-event state. Equivalent to:
   - start from `currentLabels ?? []`
   - remove anything in `removed`
   - add anything in `added` (dedup)
   - write that as `raw_labels`

   This keeps `raw_labels` and `is_archived` / `is_read` consistent in a single update, so realtime subscribers immediately drop the row from the Inbox view (same pattern we used for the outbound archive and folder auto-archive paths).

2. **Repair existing drift**: one-shot UPDATE removing `"INBOX"` from `raw_labels` on rows where `is_archived = true` AND `raw_labels @> ARRAY['INBOX']`, scoped per user. This cleans up the already-broken rows (the Gmail-archived ones the user is seeing now) without waiting for reconcile to walk them.

3. **Regression test**: extend `realtime-belongs.test.ts` (or add a small unit test next to `applyLabelChange`) covering "history event with `labelsRemoved: ['INBOX']` ⇒ resulting row has `is_archived: true` AND `raw_labels` does not contain `INBOX`".

No UI changes — the inbox query is already correct; we just need the data it reads to be correct.

## Files touched

- `src/lib/sync.server.ts` (small edit to `applyLabelChange`)
- one data repair via `supabase--insert`
- `src/lib/realtime-belongs.test.ts` (or sibling) — add case
