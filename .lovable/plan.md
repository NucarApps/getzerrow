## 1. Multi-select on the "No rules" view

When the inbox is filtered to **No rules** (`selectedFolder === "no_rules"`), enable a selection mode on the email list with two bulk actions.

### UI (`src/routes/_authenticated/inbox.tsx`)
- Add `selectedIds: Set<string>` state, active only when `isNoRules`.
- Each row in No rules shows a checkbox on the left (swipe-to-archive stays as-is when nothing is selected; suppressed while in selection mode to avoid gesture conflict).
- Tapping a row in selection mode toggles selection instead of opening it.
- Sticky action bar at the top of the list when `selectedIds.size > 0`:
  - `Re-classify (N)` — runs each through the existing classifier; if it now matches a folder, the row moves out of No rules.
  - `Suggest folder (N)` — opens a dialog with an AI-proposed new folder (name, color, ai_rule, optional filter) built from the selected emails; user clicks Create to materialize it and route the selected emails into it.
  - `Clear` and a count.

### Server (`src/lib/gmail.functions.ts`)
- `reclassifyEmails({ email_ids[] })` — loops `email_ids` (cap 100), calls the existing `classifyParsedEmail` per row (same path as `reanalyzeEmail`, just batched). Returns `{ routed, stillUnclassified, failed }`.
- `suggestFolderFromEmails({ email_ids[] })` — pulls subject/from/snippet for each id, calls `ai.server` (reuse `classifyEmail`-style gateway call with a new prompt) to return `{ name, color, ai_rule, suggested_filter? }`. No DB write.
- `createFolderAndAssign({ folder: {...}, email_ids[] })` — inserts a `folders` row, updates the selected emails' `folder_id`, marks `classified_by = 'manual'`.

## 2. Auto re-learn folders on a threshold (opt-in)

Folders the user opts into are re-learned in the background once enough new mail has landed since the last learn.

### Schema (`folders`)
- `auto_relearn boolean not null default false` — opt-in toggle.
- `relearn_threshold int not null default 25` — N new emails to trigger.
- `emails_since_learn int not null default 0` — counter; reset to 0 after each successful re-learn.

(Threshold is a column rather than a global constant so power-users can tune per folder later; default 25 is fine.)

### Counter maintenance (`src/lib/sync.server.ts`)
After an email is successfully classified into a folder (the existing insert-with-folder_id path in `classifyParsedEmail` and the batch path), increment `emails_since_learn` for that folder. Cheap UPDATE; no trigger needed.

### Worker (new TanStack server route)
`src/routes/api/public/hooks/relearn-folders.ts`
- Auth: existing `isAuthorizedCron` pattern (same as `run-folder-summaries`).
- Selects up to 25 folders where `auto_relearn = true AND emails_since_learn >= relearn_threshold`, ordered by `last_learned_at NULLS FIRST`.
- For each, runs the existing `learnFromLinkedLabel(folder_id, user_id)` and on success sets `emails_since_learn = 0`, `last_learned_at = now()`.

### Cron (insert via `supabase--insert`, not migration)
Hourly schedule that POSTs to the new hook with the `apikey` header.

### Folder editor UI (`src/components/folders/FolderEditor.tsx`)
Add a switch under the existing Learn section:
- **"Keep this folder learning automatically"** — toggles `auto_relearn`.
- When on, shows: *"Re-learns after {threshold} new emails. Last learned {date}. {emails_since_learn} new since."*

## Technical details

- The bulk Re-classify path is just a thin wrapper around the existing `reanalyzeEmail` logic — no classifier changes needed.
- `suggestFolderFromEmails` returns the same shape `AddFolderDialog` already accepts, so the create dialog can be reused with prefilled values.
- The threshold counter intentionally lives on `folders` (not derived) so the cron query stays a cheap indexed read; small drift if a manual learn happens between increments is acceptable.
- No changes to the classifier, sync loop, or webhook flow.

## Files

- `src/routes/_authenticated/inbox.tsx` — selection state, checkboxes, action bar (No rules only)
- `src/components/emails/SuggestFolderDialog.tsx` — new; preview + create
- `src/lib/gmail.functions.ts` — `reclassifyEmails`, `suggestFolderFromEmails`, `createFolderAndAssign`
- `src/lib/ai.server.ts` — `suggestFolderFromEmails` prompt helper
- `src/lib/sync.server.ts` — increment `emails_since_learn` after successful folder assignment
- `src/routes/api/public/hooks/relearn-folders.ts` — new cron hook
- `src/components/folders/FolderEditor.tsx` — auto-relearn toggle + status line
- Migration: `folders.auto_relearn`, `folders.relearn_threshold`, `folders.emails_since_learn`
- Cron job inserted via `supabase--insert` (hourly POST to the new hook)
