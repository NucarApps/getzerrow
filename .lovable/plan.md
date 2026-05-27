# Save filter rule without blocking the UI

## What's slow

In `FilterLikeThisDrawer`, `handleSave` runs two server calls:
1. `addRuleFn` — fast, just inserts the rule row.
2. `applyPastFn` / `stripLabelFn` — slow, walks past emails and moves/archives/strip-labels them. This is what the user is waiting on.

Today we `await` both before closing the drawer and showing the toast, so the user sits there watching a spinner.

## Fix

Make the past-apply pass run in the background:

1. After `addRuleFn` resolves successfully, immediately:
   - show a toast like `Future matches → <folder>` (or "kept in inbox" for the inbox-override branch),
   - invalidate the `["folder-filters"]` / `["inbox-overrides"]` / `["emails"]` / `["emails-summary"]` queries,
   - close the drawer (`onOpenChange(false)`),
   - and clear `saving` state.
2. If `applyToPast` is checked, fire `applyPastFn` (or `stripLabelFn`) **without awaiting** — kick it off via a plain `.then()/.catch()` so the drawer doesn't wait. When it resolves:
   - show a follow-up toast (`Moved N past emails to <folder>` / `Cleaned N past emails`, including `archived` / `failed` counts when relevant),
   - re-invalidate `["emails"]` / `["emails-summary"]` so the list refreshes with the past changes applied.
3. If the background pass throws, surface an error toast (`Rule saved, but moving past emails failed: …`) — same message we use today, just delivered later.

## Out of scope

- `addRuleFn` itself stays awaited — it's quick and we need its result for the "already routed" toast wording, and we want to surface validation errors synchronously.
- No backend change. `applyFilterRuleToPast` already runs server-side; we're just not blocking on it client-side.
- `MoveSimilarDialog` and other drawers aren't touched unless you want them changed too — let me know.
