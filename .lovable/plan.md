# Whole-mailbox `from:` / `to:` email search

## Goal

Typing `from:alice@x.com`, `to:bob`, or `from:"Alice Smith" invoice` in the inbox search box should match **across your entire mailbox** — by email address **and** display name — not just the ~500 most-recent emails currently loaded in the browser.

## Why it's limited today

The `from:` / `to:` operators already parse in the search box, but:

- `from:` by **email** filters server-side on the plaintext `from_addr` only.
- `from:` by **name** and **all `to:` matches** run in the browser over the ~500 rows already on screen, because sender names and recipient addresses are encrypted at rest. Older mail is silently missed.

The existing full-text index can't cleanly answer "is this person the **sender** vs the **recipient**" because its tsvector blends sender, subject, and recipient tokens together.

## The fix

Add a dedicated, encrypted-aware **participant index** so the server can answer "from this person" and "to this person" precisely and fast, then route the operator search through it.

### 1. Database
- Add a `participant_tsv` tsvector column to `email_search_index`, with two weight classes:
  - weight **A** = sender (`from_addr` + decrypted `from_name`)
  - weight **B** = recipients (decrypted `to_addrs`)
- Add a GIN index on `(user_id, participant_tsv)` so lookups stay sub-second on the biggest mailboxes.
- Populate `participant_tsv` on every write by updating the existing `upsert_email_encrypted` / `update_email_encrypted` functions (new + re-filed mail is indexed instantly).
- Add a backfill function `reindex_email_participants(batch, key)` that fills `participant_tsv` for existing rows in batches, newest-first. This only decrypts the small name/recipient fields (not bodies), so it's light.
- Add a `search_emails_participants(...)` RPC that:
  - matches `from:` needles against weight-A lexemes and `to:` needles against weight-B lexemes (so a recipient never matches a `from:` query and vice-versa),
  - optionally ANDs in free-text terms against the existing full-text index,
  - decrypts only the matched rows and returns them ranked, scoped to the selected account.

### 2. Backfill cron
- Point the existing per-minute search-reindex endpoint (`/api/public/gmail-search-reindex`) at the new participant backfill so historical mail becomes searchable by sender/recipient without a manual step.

### 3. Server function
- Extend `searchInbox` to accept parsed `from` / `to` / `rest` parts and, when an operator is present, call the new participant RPC via a `searchEmailsParticipantsDecrypted` helper; otherwise keep the current free-text path.

### 4. Inbox UI (`src/routes/_authenticated/inbox.tsx`)
- Replace the operator branch of the search query: instead of the 500-row `from_addr` ilike + local fuzzy filtering, call `searchInbox` with the parsed `from` / `to` / `rest` and render the server-ranked, pre-decrypted results directly.
- Simplify the `filtered` memo so operator results (already matched server-side) render as-is — removing the main-thread re-scoring.
- Keep the existing background "also ask Gmail for older matches" step; newly ingested rows get participant-indexed automatically.

## Result
- `from:` / `to:` match the whole mailbox by email **and** name, fast, with no freeze.
- Sender vs recipient is distinguished correctly.
- Free-text and combined queries (`from:alice invoice`) keep working.

## Rollout note
Whole-mailbox **name** matching for older emails becomes complete as the participant backfill drains (it runs automatically each minute after publish). Email-address `from:` matches work immediately. New mail is indexed on arrival.

## Technical notes
- Operator needles are converted to weight-tagged tsqueries safely by lexeme-normalizing user input (`to_tsvector` → append `:A`/`:B`), avoiding `to_tsquery` injection/syntax errors.
- `search_emails_participants` is `SECURITY DEFINER`, granted to `service_role` only, and called from the server function with the server-held `EMAIL_ENC_KEY` — never from the client.
- `participant_tsv` carries only sender/recipient tokens; the existing `tsv` (subject/snippet/body) is untouched, so the current free-text search is unaffected.

## Verification
- `EXPLAIN ANALYZE` a `from:`/`to:` query to confirm the GIN index is used.
- In the browser: `from:<email>` and `from:<name>` return matches beyond the recent window; `to:<email>` matches recipients only; combined `from:x term` narrows correctly; multi-account scoping respected; no freeze.
