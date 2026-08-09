# Paused folders still receiving mail

## What's happening

Recent mail landing in your paused folders was not filed by rules or AI — it was filed
because the folder is linked to a Gmail label. Every recent row in a paused folder is
either `gmail_label` / `gmail_labeled` (label mirror) or `manual_move` (your own moves).

The pause switch (`processing_enabled`) is checked in exactly two places today: the rule
engine and the AI classifier. The label-mirroring paths never check it, and they also
apply the folder's side effects (auto-archive, auto mark-read, hide-from-inbox, forward,
snooze) as if the folder were active. That is why paused folders look like they are still
working — and with auto-archive on, mail disappears from the inbox.

## What to change

Pause becomes "rules and AI off, side effects off — label reflection stays":

1. A paused folder still shows mail that Gmail itself labeled, so a message carrying the
   linked label still appears in the folder.
2. A paused folder applies **no** side effects: no auto-archive, no auto mark-read, no
   auto-star, no hide-from-inbox, no forward, no snooze, no folder actions, no
   scheduled actions, no digest inclusion.
3. Rules and AI stay off (already true).
4. Learning/scan paths that bulk-claim mail by Gmail label stop running for a paused
   folder, so pausing also stops re-learn and "scan Gmail" backfills from pulling mail in.
5. The folder editor's pause copy is updated to say exactly this, so the switch matches
   the behavior.

Existing mail is left as is, per your choice.

## Technical detail

- `src/lib/sync/process-message.ts`: gate the side-effect block on the resolved folder's
  `processing_enabled !== false`. This is the single place side effects are applied, so
  one guard covers archive/mark-read/star/hide/forward/snooze.
- `src/lib/sync/classify.ts`: keep the `labeledFolder` lookup (reflection stays) but mark
  the result so downstream knows the folder is paused; AI candidate filtering already
  excludes paused folders.
- `src/lib/sync/history.ts`: the label-event mirror keeps setting `folder_id`, but skips
  the paused folder's side-effect/label-write follow-ups.
- `src/lib/sync/action-dispatch.ts`, `scheduled-actions.ts`, `digest.server.ts`: skip
  folders with `processing_enabled = false`.
- `src/lib/sync/folder-learn.ts` (re-learn + Gmail label claim passes) and
  `src/lib/gmail/reprocess.functions.ts` / `rules.functions.ts` bulk paths: skip paused
  folders instead of claiming their labeled mail.
- `src/components/folders/FolderEditor.tsx`: reword the "Filtering & rules" switch
  description to state that Gmail-label reflection continues while side effects stop.
- Tests: extend `filter-engine`/`process-message` specs with a paused-folder case
  asserting the label match still resolves while every side effect is skipped.
