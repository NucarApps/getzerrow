## Goal

Make in-app folder moves train the destination folder's AI sort profile, and keep the existing Gmail-side manual-move learning. Net effect: every move you make — in our app or in Gmail — teaches the folder.

## What already exists (no work needed)

- **Gmail-side manual moves** are already detected in `syncSinceHistory` via `labelsAdded` history events.
- `recordManualMove` saves a `folder_examples` row with `source: manual_move` and triggers `regenerateFolderProfile` once ≥3 manual moves have accumulated since `last_learned_at`.
- `regenerateFolderProfile` rebuilds `folders.learned_profile` from the latest 50 examples via `buildFolderProfile` (the AI sort instructions the classifier reads).

## What's missing

- `performMove` (used by the in-app move and bulk-move flows) already upserts a `folder_examples` row with `source: "correction"` for the destination folder, but **never triggers a retrain**. So in-app moves don't update the AI profile.

## Changes

### 1. Auto-retrain on every in-app move (`src/lib/sync.server.ts`)

- After the existing `folder_examples` upsert at the end of `performMove`, kick off `regenerateFolderProfile(toFolderId)` for the destination folder.
- Wrap in `try/catch` and log on failure — a profile-rebuild error must not fail the user's move.
- Fire-and-forget is fine (don't block the move response on the LLM call). The move itself already returns success once the row is updated and Gmail labels are synced.
- This path covers both `moveEmailToFolder` (single right-click move) and `bulkMoveEmails` (multi-select / "move similar"), since both go through `performMove`.

### 2. No threshold gate for in-app moves

- Per your answer, retrain after every move (no counter, no `last_learned_at` check on the in-app path).
- The Gmail-side path keeps its existing ≥3 threshold in `recordManualMove` to avoid hammering the LLM on bulk Gmail reorganizations.

### 3. No new rules, no UI changes

- We do **not** insert hard `folder_filters` rows on in-app move — the existing right-click "Always send to folder" flow already covers explicit rule creation.
- No schema changes, no new server functions, no UI changes.

## Files touched

- `src/lib/sync.server.ts` — one ~5-line addition at the end of `performMove`.

## Out of scope

- Surfacing a toast/badge when the profile is auto-refreshed.
- Making the threshold configurable per folder.
- Auto-editing the user-authored `ai_rule` field (we only refresh `learned_profile`).
