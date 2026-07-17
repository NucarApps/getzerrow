## Goal
Add a **one-way "Pull from Google" mode** as the default entry point for Google Contacts sync. Users import their Google contacts/groups into Zerrow, clean and merge them here, and then explicitly opt in to full two-way sync as a separate step.

## UX flow (settings → Google contacts)

Per Gmail account, three states instead of one toggle:

1. **Off** — nothing syncs.
2. **Pull only (import from Google)** — default when a user first turns on sync. Cron + "Sync now" runs `pullFromGoogle` only. Local edits, adds, and deletes in Zerrow are NOT pushed back. Safe sandbox for cleanup/merging.
3. **Two-way sync** — current behavior (pull + push + tombstones).

The card shows:
- Radio group: Off / Pull only / Two-way
- A callout under "Pull only" explaining it's read-only from Google's side, safe to merge duplicates in Zerrow
- When switching Pull only → Two-way, a confirm dialog: "Local changes since import will now be pushed to Google."

## Technical changes

**DB migration**
- Add `sync_mode text not null default 'pull_only'` to `google_sync_state` with check constraint `('off','pull_only','two_way')`.
- Backfill: rows with `enabled = true` → `'two_way'` (preserves current behavior for existing users), `enabled = false` → `'off'`.
- Keep the `enabled` column for now (derived: `sync_mode <> 'off'`) to avoid breaking the existing UI/queries during rollout.

**`src/lib/google-contacts/reconcile.server.ts`**
- Read `state.sync_mode`. Branch:
  - `'off'` → return `{ ok: false, error: "sync_disabled" }` (same as today).
  - `'pull_only'` → run `pullFromGoogle` only, skip `pushToGoogle`, still bump cursors and progress. Set `last_push_count: 0`.
  - `'two_way'` → current pull + push flow.
- Progress reporter skips the "pushing…" steps in pull-only mode.

**`src/lib/google-contacts/push.server.ts`**
- No logic changes — simply not invoked in pull-only mode. Tombstones keep queuing locally; they'll flush the first time the user upgrades to two-way (existing code already drains them).

**`src/lib/google-contacts.functions.ts`**
- Replace `setGoogleContactsSyncEnabled(enabled: boolean)` with `setGoogleContactsSyncMode(mode: 'off' | 'pull_only' | 'two_way')`. Keep the old fn as a thin wrapper mapping `true → 'two_way'`, `false → 'off'` for one release so nothing else breaks.
- `getGoogleContactsSyncStatus` returns `sync_mode` in addition to existing fields.

**`src/routes/_authenticated/settings.google-contacts.tsx`**
- Swap the `<Switch>` for a shadcn `<RadioGroup>` with the three options and helper copy.
- Add confirm `AlertDialog` on the Pull only → Two-way transition.
- Show a subtle "Pull only" badge next to the account email while in that mode.

**Cron tick**
- No change; it already calls `runGoogleContactsSync` per account and the mode is read inside.

## Out of scope
- No changes to CardDAV, contact groups UI, or the mapper.
- No auto-merge/dedupe tooling — that's a separate future feature the user hinted at ("I could do the merging, the cleaning up"); existing contacts UI already supports manual merge.

## Rollout note
Existing connected accounts stay on two-way (backfill). New accounts default to pull-only so the first-time experience matches what the user asked for.