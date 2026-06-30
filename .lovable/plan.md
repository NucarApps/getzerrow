# Make email search much faster

## What's actually slow (measured)

I profiled the live search path against the largest mailbox (77k indexed messages). A common-term search currently takes **~7.7 seconds**. The query plan shows why:

- `search_emails` orders results by `ts_rank(...)`. Postgres has no way to rank from an index, so for a common word it pulls **all ~64,000 matching rows**, reads their full search vectors, scores every one, then sorts the whole set on disk.
- The search vectors are huge: the index stores up to **100,000 characters of each email body**, so the average vector is ~3.8 KB (max 164 KB). Reading them for scoring touches ~**350 MB** on every search and spills the sort to disk.

So the cost is "read and score the entire match set to rank it" combined with "vectors are enormous because we index the whole body."

## The fix (three parts)

### 1. Shrink the search vectors
Stop indexing 100k characters of body text. Index subject + sender + recipient + snippet at full weight and only the **first ~3,000 characters** of the body. This cuts the average vector roughly 5–6×, shrinks the full-text index proportionally, and removes the disk-spilling sort. Body-deep matches beyond the first few KB are rare in email and not worth the constant cost.

### 2. Order by recency from the index instead of scoring everything
Email search almost always wants "most recent matches first," not abstract relevance. Switch the default ordering to `received_at DESC` and serve it directly from a recency-aware full-text index (RUM extension, already available on this database). RUM returns the top-N most recent matches straight from the index, so a search reads ~100 rows instead of 64,000. This is the single biggest win and makes worst-case (common word) searches as fast as best-case.

### 3. Denormalize `received_at` into the search index
Copy `received_at` onto each search-index row (kept in sync on write) so ordering never has to join back to the large `emails` table.

Expected result: common-term searches drop from ~7.7s to well under ~200ms, and the pathological "popular word" case stops being slow.

## Rollout

- One migration: install RUM, add `received_at` to the search index, add the recency RUM index, drop the now-redundant standalone full-text index to cut write overhead.
- Update the write RPCs (`upsert_email_encrypted`, `insert_email_encrypted`, `update_email_encrypted`) to (a) cap body at ~3k chars in the vector and (b) populate `received_at`.
- Rewrite `search_emails` and `search_emails_participants` to order by `received_at DESC` from the index. Keep an optional relevance mode for short, rare queries if desired.
- Backfill the 145k existing rows with the smaller vector + `received_at` using the existing batched reindex cron (`/api/public/gmail-search-reindex`) — runs in the background, idempotent, no downtime. Search keeps working on old rows throughout; they just get faster as they're rebuilt.
- No client/UI changes required; the debounced server-side search call stays the same.

## Technical notes

- RUM index: `USING rum (tsv rum_tsvector_addon_ops, received_at)` enables `WHERE tsv @@ q ORDER BY received_at DESC LIMIT n` served from the index. The participant search uses the same pattern on `participant_tsv`.
- The body cap is applied in three places that build the tsvector (the two insert/upsert RPCs and the update RPC) plus the reindex functions, so new and historical rows converge on the same shape.
- Building the RUM index on 145k rows runs inside the migration; if build time is a concern we create it on the shrunk vectors after a first reindex pass.
- Redundant index `email_search_index_tsv_idx` (plain GIN on `tsv`) is dropped; the user-scoped composite already covers all queries.

## Verification

- Re-run `EXPLAIN (ANALYZE, BUFFERS)` on the same common-term query and confirm it reads ~100 rows from the RUM index with no disk sort.
- Spot-check a rare term, a `from:`/`to:` operator search, and an account-scoped search for correctness and latency.
- Confirm new incoming mail is searchable immediately (write path) and the backfill drains the historical backlog.
