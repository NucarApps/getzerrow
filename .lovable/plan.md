## Problem

Searching "rob morris" in Zerrow returns nothing, but Gmail shows many hits. There are three compounding bugs in `src/routes/_authenticated/inbox.tsx` + `src/lib/gmail.functions.ts` that swallow the matches.

### Bug 1 — Local corpus is capped at the 2000 newest emails
For free-text queries (no `from:` / `to:`), `emailsQ` loads only the 2000 most recent rows for the account and scores them locally. Anything older (e.g. the "rob morris" thread from 2022) is never in the candidate set, even if we have ingested it.

### Bug 2 — Gmail-ingested matches are hidden by the "All inbox" filter
When the user is on **All inbox** (`selectedFolder === "all"`), the search query adds `raw_labels contains INBOX` and `is_archived = false`. Most older Gmail matches are archived, so even after `searchGmailAndIngest` pulls them, they don't appear. Gmail itself searches all mail regardless of inbox state — we should match that behavior while a search is active.

### Bug 3 — Free-text Gmail search only pulls 50 newest results
In `searchGmailAndIngest`, plain text queries use `PAGE = 50, MAX_PAGES = 1`. With 50 newest matches across the mailbox, older "rob morris" hits never get ingested. Only `from:` / email / domain queries get the deep 5×100 path.

## Fix

### 1. `src/routes/_authenticated/inbox.tsx`
- When `isSearching` is true, drop the `raw_labels contains INBOX` / `is_archived = false` constraints in both the server query (lines 396, 422) and the local post-filter (line 430) for `selectedFolder === "all"`. Search should span all mail in the account (still respecting `all_mail` vs a specific folder when the user picked one).
- When `isSearching` is true, raise the free-text fetch limit from 2000 to a higher cap (e.g. 5000) and additionally fetch the rows for `gmailHitIds` directly by `gmail_message_id` so any Gmail hit gets rendered even if it falls outside the recency window. Merge + dedupe before scoring.
- Keep operator path (`from:`/`to:`) unchanged — it already queries server-side with `.limit(500)` without the recency cap.

### 2. `src/lib/gmail.functions.ts` — `searchGmailAndIngest`
- Treat free-text searches as `isDeep` too (or add a separate `isText` branch) so we page through up to 5×100 results, not 1×50. Keep the existing 200-char query cap and per-account budget.
- No change to the query-building logic (still `q = raw` for plain text, so Gmail does its own full-text matching across name/from/to/subject/body).

### 3. Verify
- Search "rob morris" → expect the 2022/2024 threads from the screenshot to appear.
- Search a current sender → still works, no regression.
- Search inside a specific folder → still scoped to that folder.

## Files touched
- `src/routes/_authenticated/inbox.tsx`
- `src/lib/gmail.functions.ts`

## Out of scope
- Changing how non-search inbox lists are filtered.
- Reworking the local search scoring / ranking.
- Background reclassification of newly-ingested search hits.
