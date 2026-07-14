# Cleanup + capability + accuracy plan

You asked for three things at once — less clutter, more capability, fewer mistakes. Several features I'd normally suggest already exist, so this plan only fills the real gaps. It's phased so you can approve/ship one slice at a time.

## What already exists (won't rebuild)
- **"Why was this filed here?"** — the reading pane already has a collapsible showing the classification reason + an AI-confidence bar.
- **Multi-select** in the inbox already supports **Re-classify** and **Suggest folder → create**.
- Emails already store `classification_reason`, `ai_confidence`, `classified_by`, `matched_filter_ids`, `matched_folder_ids`.
- Folder learning (examples, learned profile, auto-relearn cron, manual-move counter) is in place.

---

## Phase 1 — More capability: finish bulk actions (small)
The selection bar only re-classifies or suggests a folder. Add the everyday bulk actions on the same "N selected" bar:
- **Archive**, **Mark read / unread**, **Move to folder** (reuse existing folder picker), and **Move to inbox**.
- Wire to existing server fns (`archiveEmail`, `markEmailRead`, `moveEmailToFolder`, `moveEmailToInbox`) run over the selected ids with a single toast summary and one query invalidation.

Frontend-only; no new server logic.

## Phase 2 — Fewer mistakes: folder health panel (medium)
Give each folder a lightweight accuracy/health view so misfiling is visible and fixable.
- New server fn `getFolderHealth({ folder_id })` returning: total filed, count by `classified_by` (rules vs AI vs manual), avg/low AI confidence count, recent manual corrections (from folder examples / manual moves), and learning status (examples count, last relearn, emails-since-learn).
- Surface it in `FolderEditor` as a small **Health** section on the AI tab (or a compact card): "X filed · Y by AI · Z low-confidence · last learned 2d ago", with a "Relearn now" button (already exists server-side).
- Optional: a low-confidence quick-list linking back to those emails for one-click re-file.

This turns the data we already capture into something actionable, which is the main lever for fewer mistakes.

## Phase 3 — Less clutter: targeted refactors (medium)
No behavior changes — just make the giant files maintainable.
- **Settings boilerplate**: 4 settings routes repeat `AccountPicker` + `useState(scopedEmail)`. Extract a `useScopedAccount()` hook (or a `<ScopedAccountSettings>` wrapper) and reuse across `settings.inbox`, `settings.activity`, `settings.meetings-calendar`, `settings.meetings-recording`.
- **inbox.tsx is 2,959 lines**: extract self-contained pieces into `src/components/inbox/`: the email list column, the reading pane (`EmailDetail`), the selection/bulk bar, and the "suggest folder" dialog. Keep state ownership in the route; pass props.
- **FolderEditor.tsx is 2,232 lines**: split each sub-tab (Rules, AI, Automation) into its own file under `src/components/folders/editor/`, keeping the shared `local` state + save bar in the parent.

Each extraction is mechanical and verifiable by an unchanged UI.

---

## Suggested order
1. Phase 1 (fast visible win).
2. Phase 2 (accuracy — the highest-value item).
3. Phase 3 (refactors — do incrementally, one file at a time to keep diffs reviewable).

## Technical notes
- Phase 1 & 3 are presentation-only. Phase 2 adds one read-only `createServerFn` in a `*.functions.ts` module, RLS-scoped to `auth.uid()` via `requireSupabaseAuth` — no schema changes needed (aggregates existing columns/tables).
- Refactors preserve existing `local`/`dirty`/`save()` flow and all query keys; no server or business-logic edits.

## Out of scope
- No changes to the sync pipeline, filter engine, or AI classification behavior.
- No new tables or migrations.

Want me to start with Phase 1, or fold Phases 1+2 into the first build?
