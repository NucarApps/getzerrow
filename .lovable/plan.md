## Auto-claim emails on new folder + paginated folder views

### Part 1 — New folder auto-pulls from its Gmail label

**Why nothing showed up for "orders":** `AddFolderDialog` (lines 50-56) just inserts a `folders` row. Existing emails in the DB carrying that Gmail label are never re-tagged to the new folder, and no Gmail backfill runs. There's already a server function `learnFromLinkedLabel` (in `src/lib/sync.server.ts:435`) that does exactly the right thing — pulls up to 200 messages from the linked Gmail label, tags matching local rows with the new `folder_id`, and ingests any that aren't already in the DB. It just isn't wired into folder creation.

**Fix:**
- Expose `learnFromLinkedLabel` as a server fn (or use the existing wrapper if `FolderEditor` already has one — I'll check and reuse).
- In `AddFolderDialog.submit`, after the `folders` insert, if `labelId` is set (either a freshly-created label or a linked existing one), `await learnFromLinkedLabelFn({ data: { folder_id } })`.
- Invalidate `["emails"]` + `["emails-summary"]` after.
- Toast like "Folder created. Pulled N emails from Gmail."

### Part 2 — Paginated folder views (50 per page, pulls more from Gmail when needed)

**Current state:** `src/routes/_authenticated/index.tsx:87-97` does one `supabase.from("emails").select("*").limit(2000)` and filters in memory. No pagination.

**Target UX:**
- Each folder view shows 50 emails at a time (newest first).
- Pager at the bottom: ◀ Prev · "Page N" · Next ▶.
- Clicking Next:
  1. If page N+1 exists in DB → render it.
  2. If DB is exhausted and the folder is linked to a Gmail label → pull the next 50 from Gmail for that label, ingest them, then render.
  3. If DB is exhausted and no Gmail label (All / Unsorted) → disable Next.
- Search box stays global as today and bypasses pagination.

**Changes:**

1. **`src/routes/_authenticated/index.tsx`** — replace the single `useQuery(["emails"])` with one keyed on `["emails", selectedFolder, page]`:
   - Compute a cursor `before_received_at` from the last row of the current page (or `null` for page 1).
   - For `selectedFolder === "all"`: query `emails` with `is_archived=false`, `order received_at desc`, `lt received_at, cursor`, `limit 51` (51 to detect if a next page exists).
   - For `unsorted`: same plus `folder_id is null`.
   - For a folder UUID: `folder_id = selectedFolder`, no archived filter (folder views show archived as today).
   - Slice to 50 for render; `hasMoreLocal = rows.length > 50`.
   - Reset `page` to 1 when `selectedFolder` changes.
   - Search-mode keeps the existing in-memory filter, but pulls last 500 rows for the search corpus instead of 2000 (search is folder-scoped fallback only).

2. **New server fn `loadOlderFromGmail({ folder_id, before_received_at })`** in `src/lib/gmail.functions.ts`:
   - Lookup folder; require `gmail_label_id`.
   - Determine pageToken: store a per-folder `gmail_backfill_page_token` and `gmail_backfill_oldest_received_at` on the `folders` table (new nullable columns).
   - If `before_received_at` matches the stored oldest, use stored pageToken; otherwise call Gmail with no pageToken and skip past locally-known ids.
   - Call `listMessages(accountId, { labelIds: [label], maxResults: 50, pageToken })`.
   - For each id not already in `emails`, fetch + parseMessage + insert with `folder_id` set + `classified_by: "gmail_label"` (same shape as `learnFromLinkedLabel` lines 510-532).
   - Update folder with new pageToken + new oldest `received_at`.
   - Return `{ ingested, hasMore: !!list.nextPageToken }`.

3. **Pager UI** at the bottom of the email list column:
   - Prev disabled on page 1.
   - Next behavior:
     - If `hasMoreLocal` → just `setPage(p + 1)`.
     - Else if folder has a `gmail_label_id` → mutation that calls `loadOlderFromGmail`, then invalidates `["emails", selectedFolder]`, then advances page.
     - Else → disabled with tooltip "No more in this view."
   - Show "Page N" and "Loading older from Gmail…" spinner state during the mutation.

4. **Migration** to add columns to `folders`:
   ```sql
   alter table public.folders
     add column gmail_backfill_page_token text,
     add column gmail_backfill_oldest_received_at timestamptz;
   ```

### Out of scope

- No infinite scroll (explicit pager only, per your request).
- No global "Load more" across All / Unsorted from Gmail (those views aren't label-scoped — Next is local-only there).
- No change to search behavior, ordering, or right-click menus.
- No change to existing sync/watch flow.

### Risk notes

- `learnFromLinkedLabel` is capped at 200 messages on first run. If the label has thousands of historical messages, only the most recent 200 show up immediately — older ones will trickle in via the Part 2 pager (which uses Gmail `pageToken`, so it covers the whole label over time).
- The pageToken cursor stored per folder is only correct when paging strictly older. If a user creates new labeled mail mid-session, those land in DB via the normal watch and appear on page 1 — they don't disturb the older cursor.
