## What's happening

Both the inbox refresh button and Settings' "Sync now" call the same `triggerSync` server function (history sync + `reconcileLocalInbox`), and both invalidate the `["emails"]` query on success. Functionally they should produce the same result, so the fact that one "worked" and the other didn't points at one of:

1. **The reconcile silently did nothing** on the inbox click (e.g. swallowed per-row errors in `reconcileLocalInbox`, or `syncSinceHistory` threw before reconcile ran), and the success toast hid that.
2. **The refetch happened but the cached UI wasn't updated** (realtime + invalidate race, or selected message keeps the row in view).

Right now we can't tell which, because the toast just says "Synced" with no detail and `console.error` from swallowed reconcile failures isn't surfaced.

## Plan

Small, frontend + light server-side change to make the inbox refresh button observable and as reliable as Settings:

1. **Surface reconcile results in the inbox toast.** Change `syncMut.onSuccess` in `src/routes/_authenticated/index.tsx` to read the returned `{ reconciled: { checked, archived, deleted, updated }, synced?, bootstrapped?, error? }` and show e.g. `Synced · 2 archived, 1 removed` (or `Sync error: …` when `histResult.error` is set). This immediately tells us whether reconcile actually ran and what it did.

2. **Await the refetch before clearing the spinner.** Switch `qc.invalidateQueries({ queryKey: ["emails"] })` to `await qc.refetchQueries({ queryKey: ["emails"] })` and make `onSuccess` async, so the button stays in its pending state until the new list is in the cache. Same for `["folders"]` is not needed.

3. **Clear `selectedId` if the open message disappeared after refetch.** After the refetch, if `selectedId` is no longer in the new list, reset it to `null` so the reading pane doesn't keep showing a ghost of an archived/trashed email.

4. **Stop swallowing reconcile row failures silently.** In `src/lib/sync.server.ts` `reconcileLocalInbox`, count failures into the return object (`failed`) instead of only `console.error`-ing them, and include that in the toast. If the token is expired or Gmail returns 401, we'll see `failed: N` and know to reauthorize.

5. **Match Settings exactly.** Settings' `run()` invalidates both `["gmail-accounts"]` and `["emails"]`. Mirror that in the inbox `onSuccess` so `last_poll_at`-style data stays consistent (cheap, removes one more difference between the two paths).

No DB changes, no auth changes, no folder/UI restructuring — purely the refresh-button behavior and one server-fn return shape.

## Files touched

- `src/routes/_authenticated/index.tsx` — `syncMut` onSuccess (toast detail, awaited refetch, selectedId cleanup, second invalidate).
- `src/lib/sync.server.ts` — `reconcileLocalInbox` returns `failed` count.
- `src/lib/gmail.functions.ts` — no change needed (it already spreads the reconcile result).

## Open question

Is it OK to keep the same `triggerSync` server function (history + reconcile), or do you want the inbox refresh button to also run a small `backfillRecent` (like Settings' "Backfill recent 30") as a heavier fallback when history returns `{ error }`? I'd lean **no** by default — backfill is slower and you already have a dedicated button for it — but happy to wire an automatic fallback if you'd rather the inbox refresh "just always work".