## Diagnosis (verified)

- The DB has exactly **one** `Honda` group under `Factory` for your account (queried `contact_groups`). So the duplication is not in Zerrow's data — it's what iOS builds from the vCards we serve.
- Every contact vCard we serve includes both:
  1. A `CATEGORIES:` line listing the **leaf** group names it belongs to (e.g. `CATEGORIES:Honda,Factory`), and
  2. A separate `KIND:group` / `X-ADDRESSBOOKSERVER-KIND:group` vCard per Zerrow group whose displayname is styled per your setting (e.g. `Factory - Honda`).
- iOS Contacts turns each of those into a visible group entry. With the `Parent - Child` style, that produces up to three sibling group entries that all "look like" Honda under Factory:
  - The KIND:group vCard → `Factory - Honda`
  - The CATEGORIES tag on member contacts → `Honda`
  - The KIND:group vCard for the parent → `Factory` (also contains those contacts)
- Historical renames of the auto subgroup (`Nissan` → `Nissan Motor` → `Nissan North America`) also leave orphan client-side copies on iPhone if the CTag didn't force a full compare.

## Fix

1. **Stop emitting `CATEGORIES` for Zerrow group membership on contact vCards.** The `KIND:group` + `MEMBER` vCards are the canonical CardDAV way; `CATEGORIES` is what causes the second/third duplicate on iOS. `src/lib/carddav/vcard.ts` still parses inbound `CATEGORIES` from iOS PUTs (so users who assign groups on the phone keep working), we just stop sending them outbound.
2. **Bump the address-book CTag / `resync_nonce` automatically** on the next sync after this deploy, so iPhone does a full compare and drops the stale duplicate group entries in one pass. No user action required.
3. **Keep the styled displayname** (`Parent - Child` / `Parent / Child` / `Leaf`) on the KIND:group vCard — that's the piece the user actually wants.

## Files touched

- `src/lib/carddav/vcard.ts` — drop the outbound `CATEGORIES` line from `contactToVCard`; leave inbound parsing intact.
- `src/lib/carddav/handlers.server.ts` — stop passing `categories` into `contactToVCard` on both GET paths (~L376, L693). Remove the now-unused `fetchCategoriesForContact` call sites.
- `src/lib/carddav/settings.functions.ts` (or wherever `resync_nonce` lives) — one-shot bump on server start / next PROPFIND for existing users so iPhone forces a full resync.

## Verification

- Existing `src/lib/carddav/vcard.roundtrip.test.ts` — update expectations to confirm outbound vCard no longer contains `CATEGORIES` and inbound parsing still round-trips.
- Manual: on iPhone, pull-to-refresh Contacts → the three `Factory - Honda` entries collapse to one; contacts still appear under the single `Factory - Honda` group.

## Non-goals

- Not changing the group naming style, hierarchy, or the auto company-subgroup reconciler.
- Not touching the two-way sync direction — iOS-side group edits (via `CATEGORIES` on a PUT) still flow back into `contact_group_members`.
