# Make "paused" airtight for folders

## Where pause is already enforced (verified in code)

- Rule matching: `filter-engine.ts` skips paused folders.
- AI classification: `classify.ts` excludes paused folders from candidates.
- Side effects (archive, mark read, star, hide, forward, snooze, folder actions,
  digest queueing): `computeFolderEffects` / `applyFolderActions` in
  `process-message.ts` return an empty plan when the folder is paused.
- Learning: `folder-learn.ts` refuses re-learn and Gmail label scans for paused folders.
- Bulk re-run paths: `rules.functions.ts` and `reprocess.functions.ts` drop paused
  folders from their Gmail-label maps.
- Delayed work: `scheduled-actions.ts` re-checks the flag before executing.
- Learning from label events: `history.ts` filters paused folders out.

## The one real hole

The main live pipeline builds its own folder object instead of reusing the shared
resolver, and that object leaves the pause flag out. Result: for a message
processed by the normal job queue, a paused folder still gets its side effects
applied (auto-archive, mark read, star, hide from inbox, forward, snooze), because
the pause check sees "flag absent" and treats the folder as active.

Fix: carry the flag through that mapper so the existing guard fires. This is a
one-field change in `src/lib/sync/run-jobs.ts` (`resolveActionFolder` → add
`processing_enabled: cached.processing_enabled`).

## Guardrails so this cannot regress

1. A test that walks every place an `ActionFolder` is constructed and asserts the
   pause flag is propagated — a dropped field fails the suite instead of silently
   re-opening the hole.
2. Extend `paused-folder-effects.test.ts` with a run-jobs-level case: paused folder
   resolved from a cached account context produces zero Gmail mutations and no
   archive/read/snooze writes.
3. Keep the intended behavior explicit in the tests: a paused folder still *shows*
   mail Gmail itself labeled (read-only mirror), it just never acts on it.

## How you can confirm it yourself afterwards

A check against recent mail in paused folders: every row should be
`classified_by = gmail_label` / `gmail_labeled` / `manual_move`, and none of those
rows should be archived, marked read, or snoozed by Zerrow after the fix ships.

## Technical detail

- `src/lib/sync/run-jobs.ts`: `resolveActionFolder` returns `processing_enabled`
  from the cached folder so `folderProcessingPaused` works on that path.
- New/extended specs in `src/lib/sync/paused-folder-effects.test.ts` covering the
  run-jobs mapper and asserting an empty effect plan.
- No schema or UI change; no behavior change for active folders.
