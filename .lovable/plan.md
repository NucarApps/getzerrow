# Deeper relearn + domain suggestions

## What changes

### 1. Capture up to one month of label emails during relearn
Today `learnFromLinkedLabel` calls `listMessages` once with `maxResults: 50`, so any folder linked to a busy Gmail label only ever learns from the last 50 messages.

Change in `src/lib/sync.server.ts → learnFromLinkedLabel`:
- Page through `listMessages` using `nextPageToken`, passing `q: "newer_than:30d"` plus the linked `labelIds: [folder.gmail_label_id]`.
- Cap at 500 messages per relearn (Gmail's per-call ceiling × ~5 pages) to keep latency and AI cost bounded.
- Continue upserting each into `folder_examples` with `source: "seed"` (already idempotent on `folder_id + gmail_message_id`).
- After paging, run `regenerateFolderProfile(folderId)` once at the end (unchanged).

`buildFolderProfile` already takes up to 50 examples for the AI prompt — leave that cap; the extra examples improve domain suggestions and future re-learns without exploding prompt cost.

Update the toast in `folders.tsx` to reflect the higher count ("Learned from N emails from the past month").

### 2. Suggested domains panel per folder
After relearn, derive distinct sender domains from `folder_examples` for that folder and show them in the folder card as one-click chips that create a `domain contains <domain>` filter.

- New server fn `listFolderDomainSuggestions(folder_id)` in `src/lib/gmail.functions.ts`:
  - Reads `folder_examples` rows for the folder (auth-scoped via `requireSupabaseAuth`).
  - Extracts the domain from `from_addr` (lowercase, after `@`).
  - Returns `[{ domain, count }]` sorted by count desc, top 15.
  - Excludes domains that already have a matching `folder_filters` row (`field='domain' op='contains' value=domain`) so the chip list reflects unadded suggestions only.
- New server fn `addDomainFilter({ folder_id, domain })`:
  - Verifies folder ownership, inserts a `folder_filters` row `{ field: 'domain', op: 'contains', value: domain }`.

UI in `src/routes/_authenticated/folders.tsx`:
- Under each folder's "Learned profile" block, add a "Top domains in this folder" section.
- Render each suggestion as a small `Badge`/`Button` chip: `acme.com · 12`. Click → call `addDomainFilter`, optimistic-remove from list, toast confirmation.
- Refresh suggestions after relearn completes and after a domain is added.

### 3. No schema changes
`folder_filters` already supports `field='domain' op='contains'` (see `applyFilter` in `sync.server.ts`), and `folder_examples` already stores `from_addr`. Nothing to migrate.

## Files touched
- `src/lib/sync.server.ts` — paginate `learnFromLinkedLabel`, add 30-day query.
- `src/lib/gmail.functions.ts` — add `listFolderDomainSuggestions`, `addDomainFilter`.
- `src/routes/_authenticated/folders.tsx` — domain chip UI, wire to the new server fns, refresh on relearn.

## Technical notes
- Paging loop: `let pageToken; do { ... } while (pageToken && fetched < 500)`. Each page is up to `maxResults: 100`.
- Per-message fetch (`getMessage`) is still the bottleneck. 500 messages ≈ 500 sequential Gmail calls; we'll keep it sequential to respect rate limits, but log progress and surface "Learned from N emails (took Xs)" in the toast.
- Domain extraction is plain string split — addresses already normalized when stored (see `parseMessage`).
- The auto-relearn trigger after 3 manual moves (`recordManualMove`) is unchanged; it only regenerates the profile from existing examples and stays cheap.
