## Why iPhone isn't showing the new groups

iOS decides "do I need to resync?" from the address book's **CTag**. Our `computeBookCTag` already folds in:
- latest `contacts.updated_at`
- latest `contact_groups.updated_at`
- contact + group counts
- tombstone `sync_seq`
- group-name-style setting

So new groups from a successful Google pull would move the CTag on their own — **but** the earlier `requestSyncToken` 400 meant `contact_groups` rows were never inserted from Google, so CTag never moved. Two things need to happen:

1. Re-run Google **Sync now** (now that the 400 is fixed) so the missing `contact_groups` rows actually get created.
2. Give the user a **"Force iPhone resync"** button that guarantees iOS pulls again even when the underlying rows haven't otherwise changed (useful whenever a full-book refresh is needed, e.g. after fixing a mapping bug).

Also, iOS will only re-poll on its own schedule (typically ~15 min, or on app foreground / pull-to-refresh in Contacts). The button gives a way to make the *next* poll return "changed", but it does not push to the phone — the user still has to open Contacts or wait for the next poll. Removing and re-adding the CardDAV account is the only true "resync right now" mechanism iOS offers.

## Implementation

1. **Migration**: add `carddav_settings.resync_nonce integer NOT NULL DEFAULT 0`.

2. **`src/lib/carddav/handlers.server.ts`**
   - `computeBookCTag`: read `resync_nonce` alongside `group_name_style` and include it in the ETag hash. Bumping it changes the CTag → iOS pulls the whole book on its next poll.
   - Same nonce also participates in the `sync-collection` token minimum so an incremental delta report returns a fresh baseline instead of "nothing changed".

3. **`src/lib/carddav/settings.functions.ts`**: add `forceCarddavResync` server fn (auth-required) that increments `resync_nonce` for the caller's row (creating it if missing).

4. **`src/routes/_authenticated/settings.carddav.tsx`**: add a "Force iPhone resync" button next to the existing group-name-style selector, with helper text: *"Bumps the address-book tag so your iPhone pulls a fresh copy on its next sync (usually within 15 min, or immediately if you open Contacts)."*

No changes to vCard payloads, auth, or Google sync. Purely a CTag-bump lever.

## Verification

- Typecheck.
- Click the button → confirm `carddav_settings.resync_nonce` incremented, and the `PROPFIND` response for the address book returns a new `getctag`.
