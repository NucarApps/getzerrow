## Why old `from:` / `to:` searches return nothing

There is no Gmail-side time cap on search — Gmail searches the entire mailbox. The cap is on our side:

1. When you start a search, the inbox loads the **2000 newest emails** from our database (ordered by `received_at desc`) and then filters them locally by `from:` / `to:`.
2. Gmail-side search (`searchGmailAndIngest`) does pull matching messages from Gmail and ingest the missing ones — but it only requests the **50 most recent matches per account** and stops there.
3. If you have more than 2000 emails total that are newer than Bill_Baker's early-2025 mails, those Bill_Baker rows never enter the 2000-row window and never get rendered, even when they exist in the DB.

So a sender you talked to in early 2025 and then went quiet on is invisible once your DB has 2000+ newer messages.

## Fix

Change the search path so an explicit `from:` / `to:` operator query bypasses the 2000-row recency window entirely, and pulls more from Gmail than the current 50.

### 1. Operator-aware local query (`src/routes/_authenticated/inbox.tsx`)

When `isSearching` and the parsed query has `from:` or `to:`:

- Build the Supabase query against `emails` with server-side filters:
  - `from:` → `.or("from_addr.ilike.%X%,from_name.ilike.%X%")`
  - `to:` → `.ilike("to_addrs", "%X%")`
  - Any remaining free-text → `.or("subject.ilike.%X%,snippet.ilike.%X%")` AND-ed in.
- Keep `.order("received_at desc")` but raise the limit to e.g. 500 (we are already narrowing server-side, so this is bounded).
- Free-text-only search keeps today's "load 2000 newest, score locally" behavior — that path is fine.

This is the actual fix for the user's report: Bill_Baker rows in the DB will appear regardless of how many newer emails exist.

### 2. Deeper Gmail pull for operator searches (`src/lib/gmail.functions.ts`)

In `searchGmailAndIngest`:

- Detect operator queries (raw text starts with `from:` / `to:` / contains them) and treat them as "deep" searches.
- For deep searches, page `listMessages` up to a higher cap — e.g. 5 pages × 100 results = up to 500 message IDs per account before stopping. Today it stops at one page of 50.
- For plain free-text, keep the current single-page 50-result behavior to avoid runaway costs.
- Continue expanding threads + ingesting missing messages as today.

### 3. UX touch-ups

- Update the empty-state copy in inbox search ("Try a different search term.") to mention that we're pulling more from Gmail when the dot indicator is spinning — no behavior change, just clarity.
- No DB migration, no schema changes.

## Out of scope

- Full historical backfill of the mailbox (already covered by the "Deep backfill" flow in Settings).
- Server-side full-text search index (Postgres `tsvector`); the `ilike` path is enough for this volume.
- Changing how non-operator (pure free-text) search works.

## Technical notes

- `parseSearchQuery` in `inbox.tsx` already extracts `from` / `to` / `rest`. Reuse it for the server-side query builder.
- `from_addr` and `from_name` are already indexed in practice via `received_at` ordering scans being fine at ~hundreds of rows; if performance turns out poor we can add a trigram index later.
- `looksLikeEmail` / `looksLikeDomain` branches in `searchGmailAndIngest` stay as-is for bare email/domain queries; the new "deep" branch covers explicit `from:` / `to:` operators.