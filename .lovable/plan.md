## What's happening

Your "Sync now" is running an **incremental** sync — it hands Google's People API the `people_sync_token` from the previous run, so Google only returns contacts that changed since then. Nothing has changed on Google's side, so it reports 0.

The DB confirms this:
- 276 contacts locally, 270 linked to Google
- `people_sync_token` is set (incremental mode)
- Last pull counters are all 0 (incremental found no deltas)

So the 276 vs 459 gap is left over from the *first* pull — not something the current button can fix. We need a way to discard the sync token and re-pull everything from scratch.

## Plan

1. **Expose `forceFullResync` as a server fn** (`src/lib/google-contacts.functions.ts`):
   - New `forceFullGoogleContactsResync({ accountId })` — verifies account ownership, clears `people_sync_token` + `groups_sync_token` via the existing `forceFullResync` helper in `pull.server.ts`, then calls `runGoogleContactsSync` immediately so the user sees fresh counters.

2. **Add "Force full re-pull" button** (`src/routes/_authenticated/settings.google-contacts.tsx`):
   - New outline button next to "Sync now", with a confirm dialog explaining it will re-scan every Google contact (slower, but reveals what's actually skipped vs. imported).
   - While it runs, the existing progress indicator (`PullBreakdown`) shows created / updated / skipped_no_email / merged / failed counts — that's how we'll finally see where the 183-contact gap comes from.

3. **Do NOT change pull logic itself** in this step. Once the force re-pull runs, the breakdown counters will tell us the real cause (skipped for no identity, insert failures, resource-name collisions, etc.). We fix root cause as a follow-up based on that evidence rather than guessing now.

## Technical notes

- `forceFullResync` already exists in `pull.server.ts:442`; it just isn't wired to a server fn or UI.
- Reuses the existing 90s lease + `finally` unlock in `runGoogleContactsSync`, so no new locking concerns.
- No schema/migration changes.
