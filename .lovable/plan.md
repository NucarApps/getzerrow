## What already exists

`searchGmailAndIngest` (`src/lib/gmail.functions.ts:1415`) — runs a Gmail API search, ingests any matching messages we don't have, and the inbox auto-fires it 500ms after you type 3+ chars (`src/routes/_authenticated/inbox.tsx:200–222`), then refetches and toasts "Pulled N email(s) from Gmail."

## Gaps to fix

### 1. Only the oldest Gmail account is searched
`searchGmailAndIngest` resolves `accountId` to the single oldest account when none is passed (lines 1426–1438). Users with multiple connected accounts never see hits from the others.

**Fix:** when no `account_id` is passed, fetch all of the user's `gmail_accounts` and run the search/ingest pipeline against each one in sequence (or in parallel with `Promise.all`). Aggregate `ingested` and `found` across accounts in the return value.

### 2. Body-text matches get filtered out of the UI
After ingest + refetch, the local `filtered` step (`inbox.tsx:228–241`) only matches against `from_name`, `from_addr`, `subject`, and `snippet`. If Gmail matched on the body content, the row is in `pageRows` but gets hidden.

**Fix:** during search, skip the post-filter entirely — trust the server query + Gmail's full-text search. Use `pageRows` directly when `isSearching` is true (the server-side query already pulled the recent 2000 messages and Gmail just topped it up with relevant matches). This also surfaces older matches Gmail returned that wouldn't match a naive substring search.

### 3. No feedback when search has zero results
The "Checking Gmail…" hint stops on completion. If Gmail also returned nothing, the list just stays empty.

**Fix:** track the last completed Gmail search result. When `isSearching`, the list is empty, and `gmailSearching` is false, render an empty state in the list pane: "No matches in your inbox or Gmail for "{query}"." If the last search hit `no_account`, say so instead.

## Out of scope

- Searching Gmail's Trash/Spam (current query excludes them — fine for now).
- Indexing email body text into the local search corpus (separate, larger change).
- Operators like `from:` / `subject:` in the search bar (Gmail already handles them since we pass the raw string when it doesn't look like an email/domain).

## Files touched

- `src/lib/gmail.functions.ts` — multi-account loop in `searchGmailAndIngest`.
- `src/routes/_authenticated/inbox.tsx` — drop the post-filter while searching; add empty-state copy; track last search outcome.