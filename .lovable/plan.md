# Per-folder "Scan Gmail for matches" button

Add a button in each folder's edit dialog that scans the user's Gmail for any messages matching the folder's existing rules (domains, senders, subjects) and pulls them into Zerrow so they get classified into this folder.

## Where it lives

In `src/components/folders/FolderEditor.tsx`, alongside the existing filter editor — a section labeled **"Scan Gmail for matches"** with:
- A months window selector (default 6, options 1 / 3 / 6 / 12).
- A "Scan now" button.
- Result line ("Found N messages, added M new") and a spinner while running.

Folder-level placement (not Settings) so the action is contextual to the folder whose rules drive the search.

## Server function: `scanGmailForFolder`

New `createServerFn` in `src/lib/gmail.functions.ts`:

Input: `{ folder_id: string; months?: 1 | 3 | 6 | 12 }`.

Steps:
1. Load the folder, its `folder_filters`, and (when present) walk `filter_tree` to collect leaf conditions.
2. Translate each rule into a Gmail query string:
   - `field: "domain"` → `from:@<value>`
   - `field: "from"` → `from:<value>`
   - `field: "to"` → `to:<value>`
   - `field: "subject"` → `subject:"<value>"` (use `subject:<value>` for `starts_with`/`contains`)
   - `field: "body"` → raw value as free text
   - `field: "has_attachment"` (true) → `has:attachment`
   - Wrap each with `newer_than:<months>m`.
   - Skip `regex` rules (Gmail can't express them) and surface a count in the result.
3. For each query, run the same Gmail listing + thread-expansion + upsert pipeline that `searchGmailAndIngest` already uses. Extract that pipeline into a shared helper (`ingestGmailQuery(accountId, userId, query, { maxPages })`) so both fns reuse it — that helper already runs `matchFilters` against folder rules at upsert time, so freshly-ingested messages land in this folder automatically.
4. Tally totals across queries: `{ scanned, ingested, queries_run, skipped_regex }`.

Caps: max 5 pages × 100 results per query, max 20 queries per scan, hard ceiling 1000 ingested per call. Above that, return `truncated: true` so the UI can suggest re-running.

## UI wiring

- `useServerFn(scanGmailForFolder)` + `useMutation`.
- On success: toast `Scanned N messages, added M new` (or `No new matches found`), invalidate `["emails"]` and `["emails-summary"]`.
- On error: toast the message.
- Button disabled when there are zero translatable rules (show a hint: "Add a domain, sender, or subject rule first").

## Out of scope

- Background job with progress polling — start synchronous; if it proves too slow we can move to `backfill_jobs` later.
- Re-classifying already-ingested local rows (that's what the existing `applyFilterRuleToPast` per-rule action does).
- Settings-level "scan everything" button.
- Touching the AI rule or `learned_profile` — this is deterministic filter-based pulling only.

## Files touched

- `src/lib/gmail.functions.ts` — extract shared `ingestGmailQuery` helper from `searchGmailAndIngest`; add `scanGmailForFolder`.
- `src/components/folders/FolderEditor.tsx` — new "Scan Gmail for matches" section + mutation.
