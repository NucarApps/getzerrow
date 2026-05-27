# Fix free-text inbox search to actually filter (and search body)

## What's wrong

When Tony types `indeed` into the inbox search:

1. `inbox.tsx` loads the 2000 most-recent emails for his account (no body columns — bodies are encrypted at rest, and `LIST_COLUMNS` doesn't include them).
2. The local scorer (`filtered` useMemo, lines 525‑558) checks the term against `fromName + fromAddr + subject + snippet` only — it skips `to_addrs` and (necessarily) the body.
3. Critically, for free-text queries it **does not filter** — it just sorts hits first, then concatenates every non-hit after. So the user sees every recent email mixed in.
4. `searchGmailAndIngest` does run server-side and pulls body-match messages from Gmail into the local DB, but the UI has no way to mark those as hits — their `snippet` may not contain "indeed", so they fall into the non-hit tail too.

Result: Tony's search looks broken because the list is the entire recent inbox, with "indeed" matches at the top and a long tail of unrelated mail below.

## Fix

### 1. Free-text branch should filter, not sort

In `src/routes/_authenticated/inbox.tsx`, the `filtered` useMemo:
- Add `to_addrs` to the metadata haystack (currently missing).
- Change the free-text path to **return only `hit` rows** (drop the concat-non-hits trick). The "metadata hits first, others after" ordering is what's confusing Tony — when he searches, he should see matches, not everything.

### 2. Surface Gmail's body-match hits to the client

So a row that matched on body in Gmail still shows up even though its snippet doesn't contain the term:

- `src/lib/gmail.functions.ts` → `searchGmailAndIngest`: in addition to `ingested` / `found`, return `hit_gmail_message_ids: string[]` — the union of `allMessageIds` per account (already computed; just expose it).
- `inbox.tsx`: store the latest Gmail hit set in state, keyed by query string. In the `filtered` useMemo, treat a row as a hit when **either** the metadata haystack matches the free-text term **or** its `gmail_message_id` is in the current query's Gmail hit set.
- Clear / replace the hit set whenever the query changes or Gmail search returns. While Gmail search is in flight (or below the 3-char threshold), fall back to metadata-only matching — same as today.

### 3. Operator queries (`from:` / `to:`) unchanged

Those already filter correctly server-side. Don't touch that path.

## What this gives the user

Typing `indeed` will return:
- Anything whose sender name/address, recipient, or subject contains "indeed" (now including `to_addrs`).
- Anything Gmail matched on full body — those rows get ingested by `searchGmailAndIngest` and recognized via the hit-id set.
- Nothing else. No more "long tail of unrelated mail" mixed in.

## Out of scope

- Server-side body search (bodies are encrypted; this is why we delegate body matching to Gmail).
- Changing operator-query behavior.
- Search UI / debounce timing.
