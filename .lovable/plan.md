# Fix `from:` / `to:` search when a space follows the colon

## Problem

Typing `from: Bill_Baker@reyrey.com` (with a space after the colon) returns
unrelated results because the search isn't being treated as a sender filter.

## Root cause

`parseSearchQuery` in `src/routes/_authenticated/inbox.tsx` uses:

```text
/\b(from|to):(?:"([^"]+)"|(\S+))/gi
```

The value group (`\S+`) must start immediately after the colon. With a space
in between, the regex doesn't match, so:

- `parsedQuery.from` stays `null`
- `hasOperator` is `false`
- The query falls back to free-text search over the 2000 newest emails
  (subject/snippet/from scoring), which is why "everything" appears.

## Fix

Allow optional whitespace between the colon and the value in
`parseSearchQuery`:

```text
/\b(from|to):\s*(?:"([^"]+)"|(\S+))/gi
```

That's the only change. The downstream operator-aware DB query, deep Gmail
paging, and local filtering already work correctly once `parsedQuery.from`
is populated.

## Files

- `src/routes/_authenticated/inbox.tsx` — one-line regex change in
  `parseSearchQuery`.

## Out of scope

No changes to the server-side Gmail search, scoring, or UI.
