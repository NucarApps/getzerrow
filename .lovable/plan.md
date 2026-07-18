# Sync existing AI summaries to iPhone and Google Contacts

## The problem

New summaries sync fine because writing a fresh `relationship_summary` bumps `contacts.updated_at`. That bump is what both sync paths key off:

- **CardDAV**: `contactETag(id, updated_at)` — iOS only re-fetches vCards whose ETag changed (`src/lib/carddav/handlers.server.ts:437`).
- **Google Contacts push**: skips contacts unless `contact.updated_at > link.last_synced_at` (`src/lib/google-contacts/push.server.ts:157`).

Contacts whose summary was written *before* the "merge summary into NOTE" feature shipped already had their `updated_at` synced downstream without the summary. Nothing bumps them now, so they stay stale on iOS/Google even though the vCard/Person mapper would happily include the summary if asked. The `resync_nonce` bump moves the book CTag, but iOS still short-circuits per-contact refetch on the unchanged ETag.

## Fix

When `include_summary_in_notes` flips from off → on (and as a manual "resync summaries" action), touch every contact that has a non-null `relationship_summary` so both sync paths see them as changed.

### Changes

1. **`src/lib/carddav/settings.functions.ts`** — in `updateCardDavSettings`, when the new value of `include_summary_in_notes` differs from the previous value, run:
   ```sql
   UPDATE contacts
   SET updated_at = now()
   WHERE user_id = $1 AND relationship_summary IS NOT NULL
   ```
   Keep the existing `resync_nonce` bump so the book CTag also moves (belt + suspenders for iOS).

2. **`src/routes/_authenticated/settings.carddav.tsx`** — next to the toggle, add a small "Resync summaries now" button that calls a new server fn (below). Useful when the toggle was already on before this feature existed, or after regenerating summaries in bulk.

3. **New server fn `resyncSummaryContacts` in `src/lib/carddav/settings.functions.ts`** — auth-gated, runs the same `UPDATE ... WHERE relationship_summary IS NOT NULL` and bumps `resync_nonce`. Returns the affected row count so the UI can toast "Queued N contacts for resync".

4. **Google Contacts** needs no code change: bumping `contacts.updated_at` makes `pushLocalChanges` pick them up on the next push tick (5-min cron or manual "Sync now"). Mention in the toast that Google will catch up on the next sync cycle.

### Not changing

- vCard/Person mapper logic — already correct, summary merges in when the setting is on.
- `stripSummaryFromNote` on inbound PUT/pull — already prevents the AI text from being persisted back into `contacts.notes`.
- Group/CTag logic — the per-contact ETag bump is what iOS actually needs.

## Verification

- Unit: extend `src/lib/carddav/vcard.roundtrip.test.ts` (or a new settings test) to confirm toggling on flips `updated_at` for summary contacts only, and toggling off with no change is a no-op.
- Manual: with the setting already on, click "Resync summaries now", pull-to-refresh Contacts on iPhone, confirm the AI summary appears in Notes for a contact whose summary predates the feature.
