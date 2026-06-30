# Fix: search hangs on "Pulling N matches from Gmail…" and never shows results

## What's wrong

When you search (e.g. `shawn@nucar.com`), the server-side index already returns matches across your **entire mailbox** — archived mail, sent replies, and mail filed into folders included. But the inbox UI then re-applies an inbox-only scope filter to those results, discarding everything that isn't currently sitting in the inbox.

For a contact you email back and forth with, nearly all matches are archived or filed, so they all get discarded → the list shows 0 rows. At the same time the code still knows Gmail found 203 matches, so it shows the **"Pulling 203 matches from Gmail…"** placeholder indefinitely. Nothing ever loads.

This affects every search done from "All inbox" (and any folder view): search behaves as "search within this view" even though the header reads "Searching all inbox."

## The fix

Make search results span the whole mailbox, matching what the server already returns and what the UI promises.

### 1. Don't scope search results to the current folder
In `src/routes/_authenticated/inbox.tsx`:
- In the main search query (`emailsQ`, the `isSearching` branch, ~line 623), stop filtering returned rows through `emailBelongsInScope(email, selectedFolder, …)`. Search results should be shown as the whole-mailbox matches the server ranked.
- In the supplemental Gmail-hit query (`gmailHitRowsQ`, ~line 861), apply the same relaxation so freshly-ingested older/archived matches are not discarded either.
- Preserve only the genuinely-not-ready exclusions: keep filtering out in-progress / still-classifying rows (`isInProgressEmail`) and currently-snoozed rows, but include archived and folder-filed mail. (Effectively: search uses the same permissiveness as the `all_mail` scope, minus in-progress rows.)

### 2. Resolve the stuck placeholder
Once results are no longer discarded, the "Pulling N matches from Gmail…" empty state naturally disappears because rows render. As a safety net, also ensure that empty state only persists while a Gmail fetch is actually in flight or rows are still arriving — so a search that genuinely has no remaining matches falls through to the normal "No matches" copy instead of spinning forever.

### 3. Verify
- Search a sender whose mail is mostly archived/filed and confirm results now appear (not a permanent "Pulling…" state).
- Confirm normal inbox browsing (non-search) is unchanged — the scope filter still applies there.
- Confirm a truly-no-match query shows "No matches" rather than hanging.
- Run typecheck and existing inbox/search tests.

## Technical notes
- Root cause is purely client-side presentation filtering in `inbox.tsx`; the `search_emails` / `search_emails_participants` RPCs and `searchInbox` server function already return whole-mailbox results and need no change.
- No schema, migration, or backend changes required.
- `emailBelongsInScope` stays as-is for the non-search browsing path; only the search code paths change.
