## Folder History — collapsible rows, richer reasons, pagination

Rework the History tab inside `FolderEditor` so it scales to many emails and works well on mobile.

### 1. Collapsed-by-default rows
Each email becomes a single tappable row (full width, no inline action button):
- Subject (truncated, one line)
- Sender + relative time (e.g. "Acme · 2h ago") on one line
- Small reason chip on the right (color-coded): `AI`, `Manual`, `Rule`, `Seed`
- Chevron that rotates on expand

Clicking the row (anywhere) toggles an expanded panel below it. Only one row expanded at a time. This removes the always-visible "Wrong folder?" button so rows are compact on mobile.

### 2. Expanded panel — "Why is this here?"
When a row is expanded, show:

- **Reason block** (varies by `classified_by`):
  - `ai` → "Classified by AI" + the AI's reason (`ai_summary`) in a quoted block + confidence pill (e.g. `87%`).
  - `manual` → "Moved here manually" — explains a person dragged/labeled this email into the folder.
  - `rule` → "Matched a folder rule" + the matching rule field/op/value if available (best-effort lookup from `folder_filters`; otherwise just the label).
  - `seed` / `none` / unknown → "Imported with this folder" fallback copy.
- **Snippet preview** (1–2 lines from `snippet`) so the user has context without leaving the page.
- **Actions row**:
  - `Move to…` button — opens the existing folder picker (popover on desktop, bottom-sheet style list on mobile via `Drawer`-like layout already in the codebase, or just inline list under the button).
  - Picking a target folder runs the existing `suggestRecategorization` / `applyRecategorization` flow in place, reusing `RulePatchCard`. No visual changes to that sub-flow.

### 3. Load more pagination
- `listFolderHistory` already accepts `limit` (max 200). Add an `offset` parameter and return `{ emails, has_more }`.
- Default page size: 25 (was 100). Client keeps an `offset` state and appends pages with React Query's standard pattern (single `useQuery` keyed by offset, accumulate locally, or `useInfiniteQuery`). Use `useInfiniteQuery` for cleanliness.
- Render a `Load more` button at the bottom when `has_more` is true; show a spinner while fetching the next page.
- Empty state unchanged.

### 4. Reason chip styling
Centralize a small helper that maps `classified_by` → `{ label, tone }`:
- `ai` → indigo
- `manual` → emerald
- `rule` → amber
- `seed` / fallback → muted

Use semantic tokens / existing badge styles, no raw colors.

### Technical notes
- Files: `src/components/folders/FolderEditor.tsx` (UI rework), `src/lib/gmail.functions.ts` (add `offset`, return `has_more`).
- Keep `suggestRecategorization` / `applyRecategorization` and `RulePatchCard` untouched.
- For `rule` reason detail, do a lightweight `folder_filters` fetch alongside history (once per open) so we can render which rule matched when possible; if we can't determine which specific rule matched, just say "Matched a folder rule" without details.
- No DB migration needed.

### Out of scope
- Virtualized list, search/filter inside history, bulk move, exporting history.
