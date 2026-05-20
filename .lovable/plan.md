## Make search global

The email is in the system (Cold Email folder, archived). It's hidden from "All Inbox" because that view filters out archived rows, and the search bar at the top is currently scoped to the active folder, so typing "officeonkatmai" while standing on All Inbox returned nothing.

### Fix

In `src/routes/_authenticated/index.tsx` → `filtered` memo (lines 99–115):

When there is a non-empty `query`, search across **all** emails in `emailsQ.data` (including archived, including every folder), regardless of `selectedFolder`. When the query is empty, keep the existing folder-scoped behavior.

```text
if (query) {
  return all.filter(matchesQuery)        // all rows, ignore folder + archived
} else {
  apply existing folder/archive scoping
}
```

That's a ~10-line change in one memo. The query already matches `from_name`, `from_addr`, `subject`, `snippet` — no change to fields.

### UX details

- Add a small hint next to results when searching: `Searching all folders` (right-aligned in the header bar), so the user knows the scope changed.
- Clicking a search result still opens the email pane as today.
- No URL/search-param plumbing — the search box state stays local.

### Out of scope

- No change to the default folder views (still hide archived in All Inbox / Unsorted).
- No server-side search; client-side over the 2000-row cap is fine for current volumes.
- No change to classifier, overrides, or sync.
