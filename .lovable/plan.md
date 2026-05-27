## Problem

`useEmailRealtime` (`src/lib/use-email-realtime.ts`) ships incoming Postgres
changes through `rowBelongsInList(row, queryKey)`. That helper expects the
query key to look like `["emails", "all" | "inbox" | "archived" | folderId, ...]`.

But `src/routes/_authenticated/inbox.tsx` actually uses:

```
["emails", accountId, selectedFolder, paginationToken]
```

So `queryKey[1]` is the Gmail account UUID, not a scope tag. The helper sees
a string, falls through to the "treat as folder id" branch, and compares
`row.folder_id === accountId` — which is never true. Every realtime payload
(new mail, read/archive/move from Gmail, deletions) gets rejected. The cache
only refreshes on window focus or visibility change.

Net effect for Chris (and every user): inbox feels frozen, state changes from
Gmail don't reflect, and "new mail just appeared" only happens after a
refocus refetch.

## Fix

Rewrite `rowBelongsInList` to match the real inbox queryKey shape:

```
["emails", accountId?, scope?, paginationOrSearchKey?]
```

Rules (in order):
1. `queryKey.length <= 1` → true (top-level invalidations / unscoped lists).
2. If `queryKey[1]` is a string AND it matches `row.gmail_account_id`,
   continue. If it's a string but does NOT match the row's account id,
   reject (it belongs to a different account's list).
3. Inspect `queryKey[2]` (scope) and decide:
   - `undefined` / `null` → accept.
   - `"all_mail"` → accept (no filter — matches inbox.tsx).
   - `"all"` → accept only if `raw_labels` includes `"INBOX"`.
   - `"no_rules"` → accept only if `folder_id === null` AND no
     `Label_*` user label in `raw_labels`.
   - `"archived"` → accept only if `is_archived === true` (kept for
     forward-compat; harmless if unused).
   - `"inbox"` → accept only if `raw_labels` includes `"INBOX"` (legacy
     scope, kept for safety).
   - any other string → treat as folder UUID → accept if
     `row.folder_id === scope`.
4. If `queryKey[3]` starts with `"search:"` → reject inserts/updates from
   realtime (search results are recomputed; let invalidation handle them).
   For deletes we still allow the row removal.

Extend `EmailRow` type to include `gmail_account_id?: string` and (optional)
`folder_id`, so step 2 can read it. Payloads from Postgres include all
columns; no DB change needed.

Update `src/lib/realtime-belongs.test.ts` to cover:
- accountId match + scope `"all"` with/without INBOX label
- accountId mismatch → reject
- `"no_rules"` scope filtering
- folder-UUID scope match
- `"search:..."` key → reject for INSERT/UPDATE

No other files change. The `applyInsert` / `applyUpdate` / `applyDelete`
plumbing already handles whatever the predicate accepts.

## Out of scope

- Reconcile throughput for 40k+ mailboxes (Chris has 40,325 rows; reconcile
  walks ~360/tick). It still self-heals over time. If real-time drift
  remains after this fix, we can tune `HEAD_LIMIT` / `TAIL_LIMIT` /
  archived window in a follow-up.
- Gmail webhook / history sync — verified healthy via `pubsub_events`
  (`accounts_matched=1`, `synced_count>0`, last push 30s before report).
- Server-side label-change handling (`applyLabelChange`) — already writes
  the correct patch; the issue is purely client-side cache filtering.
- `useEmailRealtime` subscription wiring — already correct (mounted in
  `_authenticated.tsx`, JWT re-auth in place, visibility catch-up works).

## Verification

1. Open inbox as Chris, watch a new mail arrive in Gmail → row should
   appear in Zerrow without refresh.
2. Archive/read/move a message in Gmail → corresponding row in Zerrow
   should update within ~1s (push → DB UPDATE → realtime → cache patch).
3. Move a message between folders inside Zerrow → row leaves source list,
   appears in destination list without refresh.
4. Run `bunx vitest run src/lib/realtime-belongs.test.ts`.