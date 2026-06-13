# Speed up inbox loading & refresh

Goal: make the inbox render faster on first paint, refresh instantly, and stop the background work that's hammering the database. Findings below are grounded in the live DB's slowest-query stats and the current query code.

## What's slow today

```text
#1  214,778 calls  ~20,000s total   sidebar unread-count query (5,000 rows/account)
#2   94,507 calls  ~14,000s total   a "select *" emails scan (to be pinned down)
#3   38,878 calls   ~3,360s total   inbox INBOX list query (metadata)
#4    9,437 calls   ~2,990s total   inbox list (older variant)
```

Root causes:
1. The sidebar counts query fetches up to 5,000 rows per account and counts in the browser. It's keyed under `["emails"]`, so every email action and every realtime event re-runs it.
2. The list renders in two round-trips: metadata first, then a second server call to decrypt subject/sender/snippet — so the list looks blank until the second call lands.
3. The list refetches every 15s even though realtime already pushes changes, plus a 45s Gmail reconcile loop runs per open tab.
4. Refresh and most actions invalidate the entire `["emails"]` key, refetching every cached page and the counts query instead of just the current view.

## Plan

### 1. Move unread counts to a server-side aggregate (biggest win)
- Add a `SECURITY DEFINER` SQL function `get_folder_unread_counts(p_account_id uuid)` returning per-folder unread counts, the `no_rules` count, and the inbox total — computed with `COUNT(...) GROUP BY` in Postgres instead of shipping 5,000 rows.
- Replace the 5,000-row `emailsQ` in `src/routes/_authenticated.tsx` with a call to this function.
- Key it as `["folder-counts", accountId]` (NOT under `["emails"]`) so routine email mutations don't sweep it. Refresh it via realtime + an explicit invalidate after actions that change unread state.

### 2. Collapse the inbox list into a single decrypted, paginated RPC
- Add `get_emails_list_decrypted(p_account_id, p_scope, p_folder_id, p_cursor, p_limit, p_key)` that filters/paginates server-side and returns the list columns already decrypted (subject, snippet, from_name, ai_summary, classification_reason) in one shot.
- Add a server fn wrapper in `src/lib/email-body.functions.ts` (or a new `email-list.functions.ts`) using the existing `EMAIL_ENC_KEY` pattern from `encrypted-reader.ts`.
- Rewrite `emailsQ` in `src/routes/_authenticated/inbox.tsx` to call it, removing the separate `getEmailListFields` / `listFieldsQ` second round-trip for the normal (non-search) path.
- Net effect: one round-trip instead of two; the list shows sender/subject on first paint.

### 3. Stop redundant background refetching
- Remove `refetchInterval: 15_000` from the inbox list query (realtime already keeps it live), or raise it to 60s as a safety net.
- Reduce the in-component 45s reconcile loop to run once on mount + on manual refresh, leaning on the existing 15-minute cron reconcile as the backstop. Keep `refetchOnWindowFocus`.

### 4. Narrow cache invalidation to the active view
- Replace blanket `qc.invalidateQueries({ queryKey: ["emails"] })` / `refetchQueries(["emails"])` in `inbox.tsx` and `use-email-realtime.ts` with the current folder/page key where possible, so a single action no longer refetches every cached page + counts.
- Keep the existing optimistic `setQueriesData` updates; just drop the broad follow-up refetch where realtime + optimism already cover it.

### 5. Indexing
- Add a partial index to match the dominant INBOX query shape:
  `CREATE INDEX emails_inbox_active_idx ON public.emails (gmail_account_id, received_at DESC) WHERE is_archived = false;`
- Add a GIN index on `raw_labels` if `EXPLAIN` shows the `raw_labels @> ['INBOX']` containment is still scanning after the partial index.
- Re-run `EXPLAIN (ANALYZE, BUFFERS)` on the inbox query before/after to confirm the plan improves.

### 6. Pin down and scope query #2
- Identify the source of the `select *` emails scan (94k calls). Likely a summary/report/learn path selecting all columns including encrypted bodies. Narrow it to the columns it actually needs and ensure it's account- or user-scoped and indexed.

## Technical notes
- All new SQL: `public` schema function with explicit `GRANT EXECUTE ... TO authenticated, service_role`, `SET search_path = public`, and never expose `EMAIL_ENC_KEY` to the client (server fns pass `p_key` from `process.env`, same as `get_emails_decrypted`).
- Counts function reads `is_read`, `raw_labels` (for INBOX membership), `folder_id` — no decryption needed, so it can be a plain aggregate.
- Search path (operator + free-text) keeps its current behavior for now; the single-RPC change targets the default folder/inbox views that dominate traffic.
- Verification: after each change, re-check `slow_queries` and confirm call counts/total time on the counts and list queries drop, and confirm the inbox still updates live via realtime.

## Expected impact
- Eliminates the 5,000-row-per-account count fetch (the single largest DB load).
- Halves round-trips for the list (one decrypted RPC instead of two calls).
- Cuts steady-state background load from 15s polling + 45s reconcile per tab.
- Faster first paint and snappier refresh, with fewer redundant refetches per action.
