## Plan

Clear the inbox search box automatically when the user switches folders.

### Change

In `src/routes/_authenticated/inbox.tsx`, watch the selected folder. Whenever it changes, reset the search query state to an empty string (and clear the related Gmail-search result state so stale "Pulled from Gmail" messaging doesn't linger).

### Verification

- Type a search term, switch folders → search input clears and the folder's normal list renders.
- Switching back to the original folder shows that folder's normal contents (no leftover search filter).