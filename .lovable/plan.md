## Goal

Make the inbox search bar understand Gmail-style `from:` and `to:` operators so a query like `from:Bill_Baker@reyrey.com` filters the local list against the sender field (and combined `to_addrs`), instead of looking for the literal string `from:Bill_Baker@reyrey.com` in subject/snippet.

## Background

Two search paths run for the search bar in `src/routes/_authenticated/inbox.tsx`:

1. **Gmail-side** (`searchGmailAndIngest` in `src/lib/gmail.functions.ts`) — already passes the raw query through to Gmail, which natively understands `from:` and `to:`. The only special-casing is auto-prefixing `from:` for bare emails/domains, which still works.
2. **Local-side** (the `filtered` memo in `inbox.tsx`, lines ~422-443) — builds a haystack of `from_name + from_addr + subject + snippet` and does a plain `includes(query)`. This is where `from:` / `to:` are not understood today.

## Changes — `src/routes/_authenticated/inbox.tsx` only

Add a tiny query parser used by the local `filtered` memo:

- Parse the query into `{ from?: string, to?: string, rest: string }`.
- Tokens recognised (case-insensitive, anywhere in the string): `from:<value>` and `to:<value>`. Values are read until the next whitespace; values wrapped in `"..."` allow spaces. Multiple `from:` / `to:` are not needed in v1 — last wins.
- The remaining tokens (stripped of the operator pairs) are joined into `rest` and used as the existing free-text needle.

New matching logic in the `filtered` memo:

- For each row, lowercase `from_addr`, `from_name`, `to_addrs`, `subject`, `snippet`.
- `from:` filter — row matches if `from_addr` OR `from_name` contains the value (case-insensitive). Underscores/dots are kept as-is so `Bill_Baker@reyrey.com` matches exactly.
- `to:` filter — row matches if `to_addrs` contains the value.
- `rest` — falls back to today's haystack `includes(rest)` check.
- A row is a "hit" only if ALL provided filters match. The current "metadata hits first, others after" ordering is preserved so freshly-ingested Gmail body matches still show up beneath.

The Gmail-side fetch already works: `query` is forwarded verbatim, and Gmail interprets `from:` / `to:` natively. No change to `searchGmailAndIngest`.

## Out of scope

- `subject:`, `has:attachment`, `before:`, `after:`, OR/AND syntax — can come later if needed.
- Search inside the contact drawer or any other view.
- Changing the Supabase-side initial fetch (still returns the most recent 2000 messages and then filters client-side, same as today).
