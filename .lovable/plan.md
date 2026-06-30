# Make email search fast and stop the freeze

## What's wrong today

Free-text inbox search ignores the full-text search infrastructure that already exists and instead does the heaviest possible thing in the browser:

1. On **every keystroke** (no debounce), it fetches up to **5,000 raw email rows** for the account.
2. It then makes a second server round-trip to **decrypt up to 5,000 rows** (`getEmailListFields`).
3. It then runs **fuzzy token scoring** over all of them on the main thread (`decodeEntities`, edit-distance matching).

For large mailboxes (one account here has ~76k emails) this locks up the tab and forces a page refresh.

Meanwhile the app already has everything needed for instant search, just unused by the UI:
- `email_search_index` table with a `tsv` column, GIN-indexed, fully populated (144k rows, 0 missing).
- A ranked, paginated, decrypting RPC `public.search_emails(user_id, query, limit, offset, key)` using `websearch_to_tsquery` + `ts_rank`.

## The fix

Route search through the existing server-side full-text RPC instead of the browser, debounce input, and abort stale requests. Add a composite DB index so ranking is fast even on the biggest mailboxes.

### 1. Database (migration)
- Enable the `btree_gin` extension and add a composite index `email_search_index USING gin (user_id, tsv)`. This removes the current "BitmapAnd of two separate indexes" step (measured ~1.1s on the 76k mailbox) and lets a single index serve the user-scoped ranked lookup.
- Extend `search_emails` to accept an optional `p_account_id uuid` so multi-account users only search the selected account, and so results don't need re-filtering for the wrong account. Keep the existing signature working (overload / default) to avoid breaking anything.

### 2. Server function
- Add a `searchEmailsDecrypted(...)` helper in `src/lib/sync/encrypted-reader.ts` that calls `search_emails` via `supabaseAdmin` with `EMAIL_ENC_KEY` and the caller's `userId`.
- Add a `searchInbox` server function (`createServerFn` + `requireSupabaseAuth`) in `src/lib/email-body.functions.ts`. It takes `{ query, account_id, scope, folder_id, limit }`, derives `userId` from the auth context (never the client), and returns already-decrypted, ranked rows. The RPC is `service_role`-only, so this stays server-side.

### 3. Inbox UI (`src/routes/_authenticated/inbox.tsx`)
- Replace the free-text search branch of `emailsQ`: instead of the 5,000-row fetch + `getEmailListFields` decrypt + local fuzzy scoring, call `searchInbox` and render its ranked, pre-decrypted results directly.
- Debounce the search input (~300ms) so we don't fire a query per keystroke, and let React Query abort superseded searches (stable query key on the debounced term).
- Apply the existing `emailBelongsInScope` filter on the small returned set (≤200 rows) for folder/no-rules scoping — cheap now.
- Keep the existing "also ask Gmail and ingest older matches" background step; newly-ingested rows already update `email_search_index`, so they flow into the next search automatically.
- Remove the now-dead local fuzzy-scoring path for search (keep it only if still needed for the operator `from:`/`to:` view, which the RPC otherwise covers).

## Result
- Search returns ranked matches from a server-side index in well under a second instead of downloading and decrypting thousands of rows in the browser.
- No more main-thread fuzzy scoring over the whole corpus, so the tab no longer freezes and you won't need to refresh.
- Searching spans all mail (as Gmail does) and respects the selected account.

## Verification
- `EXPLAIN ANALYZE` the new composite-index query to confirm the BitmapAnd is gone and latency drops.
- In the browser: type a query in a large mailbox, confirm results appear quickly, no freeze, and stale in-flight searches are cancelled.
- Confirm multi-account scoping (results only from the selected account) and folder scoping still behave.

## Technical notes
- `search_emails` is `SECURITY DEFINER` and granted only to `service_role`; it must be called from the server function with the server-held `EMAIL_ENC_KEY`, never from the client.
- `email_search_index` is kept fresh by `upsert_email_encrypted` / `update_email_encrypted` at ingest/update time, so no backfill is required (already 0 missing).
