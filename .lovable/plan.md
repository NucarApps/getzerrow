## Goal

Add a per-folder on/off switch that makes a folder inert — no rule matching, no AI classification, no side-effects — without deleting its rules. Flipping it back on resumes exactly where it left off.

Today `skip_ai` only disables AI; deterministic filters (`filter_tree` / `folder_filters`) still run. There is no single "pause this folder" control.

## Changes

### 1. Schema
- Add `folders.processing_enabled boolean not null default true`.
- Backfill existing rows to `true`.

### 2. Sync pipeline (`src/lib/sync/`)
- Extend `FolderForClassify` in `types.ts` with `processing_enabled`.
- Add `processing_enabled` to the folder select list in `types.ts` (line 39) and every fetch that feeds classification.
- In `filter-engine.ts` (`matchByFilters`) and `classify.ts` (AI candidate set), skip any folder where `processing_enabled === false` before evaluating rules or AI.
- Gmail label sync (folders with `gmail_label_id`) also skips when disabled.

### 3. Folder editor UI
- In `FolderEditor.tsx`, add a prominent `Switch` at the top of the folder header labeled "Enable filtering & rules" bound to `processing_enabled`.
- When off: dim the rules/AI/behavior sections and show a small "Paused — new mail bypasses this folder" hint. Filter tree and AI rule stay editable so the user can prepare rules while paused.
- Persist through the existing `updateFolder` server fn (already accepts arbitrary patch fields — just add `processing_enabled` to the allowed keys).

### 4. Folder list
- In the sidebar / folder list, show a small paused indicator next to disabled folders so the state is visible without opening the editor.

### 5. Tests
- Extend `filter-engine.test.ts`: disabled folder is never returned as a match even when filters would.
- Extend `classify-ai.test.ts`: disabled folders excluded from AI candidate set (mirrors the existing `skip_ai` test).

## Out of scope

- Bulk enable/disable across folders (can be a follow-up).
- Retroactively moving already-filed mail out of a paused folder — pause only affects new incoming mail.
- Scheduled/timed pauses.

## Technical notes

- Historical mail already filed into the folder stays put; pause is forward-only. This matches the existing "inert by default" contract for rule-less folders.
- Digest / summary schedules attached to a paused folder keep running against whatever mail is already inside — a separate concern from classification.