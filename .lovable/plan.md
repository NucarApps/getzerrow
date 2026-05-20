## Goal

Add a tabbed interface to the folder editor: **Settings** (existing UI, default) and **History** (emails processed into this folder), so the user can audit classifications and, when something landed in the wrong place, have the AI propose rule updates for both the source and destination folders before applying them.

## UI changes — `src/components/folders/FolderEditor.tsx`

Wrap the editor body in shadcn `Tabs` with two tabs:

- **Settings** (default, value `"settings"`) — current FolderEditor body, unchanged.
- **History** (value `"history"`) — new panel.

The top row (color swatch, name, priority, delete) stays above the tabs so it's always visible.

### History tab contents

A scrollable list of the most recent emails routed to this folder (limit 100, ordered by `received_at desc`). For each row:

- Subject + from name/address
- Received timestamp
- **Reason chip** derived from `classified_by`:
  - `gmail_label` → "Matched Gmail label"
  - `filter` → "Matched filter" (resolve which filter matched if possible; fallback to generic label)
  - `domain_rule` → "Domain rule"
  - `manual_move` → "Moved manually"
  - `ai` → "AI · {confidence}%" + show `ai_summary` underneath as the rationale
  - `none` → "Unclassified"
- **"Wrong folder?"** action → opens a target picker (same folder picker we already use for domain reassignment). User selects a destination folder.

Empty state: "No emails have been processed into this folder yet."

### Recategorize flow (per email)

When the user picks a destination folder:

1. Call a new server fn `suggestRecategorization` (see below). Show a small "Asking AI…" inline spinner.
2. Render a confirmation card (inside the History row that expands, no new modal) with:
   - "Move 1 email from {source} → {target}" summary
   - Two side-by-side proposed updates:
     - **Source folder ({this folder})** — diff: current `ai_rule` / `learned_profile` vs proposed (the proposed version explicitly excludes this pattern).
     - **Target folder** — diff: current vs proposed (explicitly includes this pattern).
   - Two checkboxes (default checked): "Update source folder rule", "Update destination folder rule".
   - Buttons: **Apply** / **Cancel**.
3. On Apply, call `applyRecategorization` (see below), which moves the email and writes the accepted rule updates atomically. Refresh `emails`, both `folders-full` entries, and the relevant `folder-examples` / `folder-domains` queries.

## Backend changes — `src/lib/gmail.functions.ts` (+ helpers in `src/lib/sync.server.ts` if needed)

Two new auth-protected server functions:

### `suggestRecategorization`
- Input (zod): `{ email_id: uuid, to_folder_id: uuid }`
- Loads the email, the source folder, and the target folder (verifies all belong to `userId`).
- Calls Lovable AI Gateway (`google/gemini-2.5-flash`) with a prompt that includes:
  - The email's `subject`, `from_addr`, `from_name`, trimmed `body_text`/`snippet`, current `ai_summary`/`classified_by`.
  - Both folders' `name`, current `ai_rule`, current `learned_profile`.
- Returns DTO `{ source: { current_rule, proposed_rule, current_profile, proposed_profile, why }, target: { ... } }`. Falls back to a deterministic edit (append/remove a sentence about the sender domain or subject pattern) if the AI call fails — never throws on AI failure, returns `error: string` in the DTO instead.

### `applyRecategorization`
- Input (zod): `{ email_id: uuid, to_folder_id: uuid, apply_source: boolean, apply_target: boolean, source_rule?: string|null, source_profile?: string|null, target_rule?: string|null, target_profile?: string|null }`
- Moves the email (`folder_id = to_folder_id`, `classified_by = "manual_move"`, `ai_confidence = 1`) and syncs the Gmail label (reuse the existing label-swap helper used by `reassignDomainToFolder`).
- If flags are true, updates the respective folder rows. Bumps `last_learned_at` for the touched folders.
- Inserts a `folder_examples` row for the target folder so the AI profile reflects the correction; deletes any matching `folder_examples` row from the source folder.
- Returns `{ moved: 1, source_updated, target_updated }`.

Both functions use `requireSupabaseAuth` and the user-scoped supabase client (RLS-respecting). No schema changes required — everything fits the existing `emails`, `folders`, `folder_examples` tables.

## Out of scope

- No changes to the sidebar, inbox list, or settings page.
- No design-token or theme changes.
- No bulk recategorization — one email at a time for now.

## Technical notes

- Reuse the existing `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` shadcn primitives.
- Reuse the existing folder picker pattern (`Popover` + `otherFoldersQ`) from the domain reassignment row.
- AI prompt should return strict JSON (`response_format` or explicit "return ONLY JSON" instruction with a Zod parse on the server) so we can render diffs without text wrangling.
- Keep AI calls bounded: trim body to ~2k chars, single request per "Wrong folder?" click. No streaming needed.
