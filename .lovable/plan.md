## Add search to the email list

Add a search input in the header of the email list pane in `src/routes/_authenticated/index.tsx`. Because the same list pane renders both the Inbox (All / Unsorted) and any folder view, one input covers both cases.

## Behavior

- Case-insensitive substring match across each email's:
  - `from_name` (e.g. "John Smith" → matches "john", "smit", "ohn smi")
  - `from_addr` (e.g. "john.smith@acme.com" → matches "acme", "smith")
  - `subject` and `snippet` (so partial subject search also works)
- Empty query → no filter applied.
- Search is purely client-side over the already-loaded `emails` list — no new server call, no schema change.
- Search resets the selected email only if the current selection no longer matches.
- Persisted in component state (clears on full page refresh). Lives next to existing list state.
- Header count next to the folder name reflects the filtered count.

## UI

- Small input under the existing header row (folder name + refresh button), full-width, with a leading magnifier icon and a clear (×) button when there's text.
- Placeholder: "Search by name, email, or subject".
- Uses existing `Input` + `lucide-react` `Search` / `X` icons. No new dependencies.

## Files

- `src/routes/_authenticated/index.tsx` — add `query` state, the input, and a `useMemo` filter on top of the existing `filtered` array.

## Out of scope

- No server-side full-text search.
- No search inside email bodies (`body_text` / `body_html`) — keeps the index of in-memory rows fast; can be added later if needed.
- No global search across folders (the current folder/inbox selection still scopes the list).
