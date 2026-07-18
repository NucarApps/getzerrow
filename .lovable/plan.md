## Problem

The "Resync summaries now" button (and the `include_summary_in_notes` toggle side-effect) throws `column contacts.relationship_summary does not exist`. That plaintext column was dropped in migration `20260528105923` in favor of the encrypted `relationship_summary_enc` (bytea), but two queries in `src/lib/carddav/settings.functions.ts` still filter on the old name.

## Fix

In `src/lib/carddav/settings.functions.ts`, change both `.not("relationship_summary", "is", null)` filters (lines 111 and 143) to `.not("relationship_summary_enc", "is", null)`. Same intent — "touch every contact that has a stored AI summary" — but against the column that actually exists.

## Verify

- Click "Resync summaries now" → succeeds and returns a count.
- Toggle "Include AI summary in notes" off/on → no error; contacts with summaries get their `updated_at` bumped.
- Run the existing carddav regression tests (`bun test src/lib/carddav`) to confirm nothing regressed.

## Out of scope

- The `row.relationship_summary` reads in `state.server.ts` / `crud.functions.ts` don't throw (they just resolve to undefined and are already superseded by the `get_contacts_decrypted` RPC path used elsewhere). Not touching them in this fix.
