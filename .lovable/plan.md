# Make new mail appear instantly

## Goal

Today, an email that needs AI classification is inserted as `classified_by = 'pending_ai'` and **deliberately hidden from the inbox** until the AI pass finishes (fetch + up to a 5s attempt / 18s budget). Rule-matched mail already lands instantly; only AI-bound mail feels slow.

Change: surface `pending_ai` mail in the inbox the moment it arrives, then let it quietly settle into its destination folder once AI finishes. You accepted the brief "appears, then moves into a folder" behavior.

`pending` (rows still being repaired/retried, not yet fully populated) stays hidden everywhere — only `pending_ai` (fully-parsed mail waiting on the AI step) is surfaced.

## Where the gate lives

The same "never show in-progress mail" rule is enforced in four spots that must stay in agreement:

```text
push → syncSinceHistory → enqueue → worker inserts row
   rule-matched  → INSERT straight into folder      (already instant)
   needs AI      → INSERT classified_by='pending_ai' → AI pass UPDATEs it
                       ▲ hidden here today            ▲ only shows after AI

gate 1: get_emails_list_decrypted RPC   (server list — cold load / refetch)
gate 2: get_folder_unread_counts RPC    (inbox unread badge)
gate 3: matchesScope() in use-email-realtime.ts (live insert/update splicing)
```

If we only relax the client, a 30s refetch would drop the row again; if we only relax the server, realtime inserts wouldn't splice it in. All must change together.

## Behavior after the change

- New AI-bound email arrives → row appears in the inbox immediately (it carries the INBOX label and `is_archived=false`, folder still null).
- AI finishes and files it into a **hidden/auto-archive folder** → realtime UPDATE fires, `matchesScope` no longer matches, the row is removed from the inbox list (the accepted "move into folder").
- AI keeps it in the inbox (visible folder / kept / unclassified) → it simply stays; no flash.
- `no_rules` and folder views keep excluding `pending_ai` (they only ever showed settled mail), so the change is scoped to the main inbox.

## Changes

### 1. Migration — relax the two RPCs

New migration `CREATE OR REPLACE`-ing both functions (public schema, `SECURITY DEFINER` preserved, no new tables so no new grants):

- `get_emails_list_decrypted`: split the blanket `classified_by NOT IN ('pending','pending_ai')` gate so that:
  - `pending` is excluded in every scope.
  - `pending_ai` is **allowed** in the `all` (inbox) branch, still **excluded** from the `no_rules` branch. The `folder` branch is unaffected (pending_ai rows have `folder_id = null`, so they never match a folder UUID).
- `get_folder_unread_counts`: in the `total` CTE (inbox badge), allow `pending_ai` so the badge count matches the list; keep excluding it from the `no_rules` CTE.

### 2. `src/lib/use-email-realtime.ts` — mirror in `matchesScope`

Rework the in-progress guard to be scope-aware instead of a blanket early return:
- `pending` → always return false.
- `pending_ai` → return true only for the `all` / `inbox` scope (still gated on the INBOX label + `is_archived !== true`); return false for `no_rules`, `archived`, and folder scopes.
- Everything else unchanged.

This keeps the realtime insert path (`rowBelongsInList` → `matchesScope`) and the settling UPDATE/remove path (already handled by `applyPendingOpsToList`'s `present && !belongs` branch) consistent with the server.

## Out of scope / unchanged

- No change to the worker, webhook inline-drain budget, AI model, or classification logic — this is purely about *when the row becomes visible*, not how fast AI runs.
- `pending` handling, `all_mail` (already shows everything), search, and folder/no_rules views stay as-is.

## Verification

- Reconnect an account or send a test email; confirm the new message shows in the inbox before AI finishes, then settles (moves out if filed to a hidden folder, stays otherwise).
- Confirm the inbox unread badge and the list agree during the pending window.
- Confirm `no_rules` and folder views do not show `pending_ai` rows.
- Run the existing `use-email-realtime` unit tests (`realtime-belongs.test.ts`) and update expectations for the new pending_ai-in-inbox behavior.
