## Problem

When Jared creates a folder named "Kenect Reports":
- `AddFolderDialog.submit()` tries to create a Gmail label with that name. Gmail returns the existing label (or the fallback path finds it), so `labelId` ends up pointing at the pre-existing "Kenect Reports" Gmail label full of history.
- The dialog then calls `learnFn` (`learnFromLinkedLabel`) which ingests every historically-labeled message into the new folder.
- Naming it "Kenect" (no matching Gmail label) skips that path, so the folder stays empty — which matches the "inert by default" contract; "Kenect Reports" does not.

The fix is to keep the folder truly inert on creation: no learning, no ingestion, no mirroring, until the user explicitly opts in (adds an AI rule, adds a filter, or turns on mirroring).

## Plan

1. **Stop auto-learning on folder create.** In `src/components/folders/AddFolderDialog.tsx`, remove the `learnFn` call and the "Pulling emails from Gmail…" toast branch. Always show the plain "Folder created." toast regardless of whether a Gmail label was linked. The folder still stores `gmail_label_id` so a later user action can mirror if they want.

2. **Gate mirroring/learning behind an explicit intent flag.** Learning-from-linked-label should only run when the user takes an action that expresses intent:
   - Adds an AI rule (already flips `skip_ai=false` on save in `FolderEditor`).
   - Adds a `filter_tree` / simple filter (extend the same auto-flip to also trigger a one-time learn if a Gmail label is linked).
   - Explicitly clicks "Pull from Gmail label" in the folder editor (new button, only visible when a Gmail label is linked and the folder is still inert).

3. **One-time cleanup for Jared.** Kenect Reports currently holds 9+ historically-imported messages that arrived via this auto-learn path. Move them back to inbox (unclassify) so his folder starts empty, matching his expectation. Do not touch the Gmail label itself.

4. **Regression coverage.** Add a test in `src/components/folders/` (or extend the existing folder-mgmt test) asserting that folder creation never invokes `learnFromLinkedLabel`, and that an inert folder with a linked Gmail label does not surface historical mail until an explicit action is taken.

## Technical notes

- `learnFn` in `AddFolderDialog.tsx` currently calls `learnFromLinkedLabel({ folder_id })` right after insert. That's the ingestion trigger for the "flying with the same emails" symptom.
- `FolderEditor.tsx` already auto-flips `skip_ai=false` when a user adds an AI prompt (prior turn). We'll extend it so saving with a newly-added `filter_tree` on a label-linked folder also runs `learnFromLinkedLabel` exactly once.
- The new "Pull from Gmail label" button is only for the mirror-only case where the user wants Gmail-side sorting mirrored without any Zerrow rules — it calls `learnFromLinkedLabel` on demand.
- No schema changes.

## Files touched

- `src/components/folders/AddFolderDialog.tsx` — drop auto-learn.
- `src/components/folders/FolderEditor.tsx` — add opt-in "Pull from Gmail label" action; auto-learn on first filter/rule save when label is linked.
- One-time SQL to unclassify the 9 Kenect Reports messages back to inbox for Jared's account.
- Test file covering the new inert-creation contract.
