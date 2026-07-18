Do I know what the issue is? Yes.

Problem confirmed from the live data:
- Bryan Barks is still linked to the old company record: `Volkswagen Group of America Inc.`, not the canonical `Volkswagen` company.
- There are actually three Volkswagen-related company records in the backend data: `Volkswagen`, `Volkswagen Group of America Inc.`, and `VW`.
- Bryan still has a saved `avatar_url`, so the UI first renders the live company logo fallback, then the signed saved photo loads and replaces it. That is the flicker.
- The visible label is coming from the old auto-generated contact group/subgroup membership named `Volkswagen Group of America Inc.`.

Plan:

1. Add durable photo provenance and logo-echo protection
   - Add an `avatar_source` field for contacts so future photos are distinguishable as user-uploaded, CardDAV/iPhone, Google, or unknown legacy data.
   - Add a company-logo hash history table so when a company logo changes, older logo snapshots can still be recognized as company-logo echoes later.
   - Update all photo write paths:
     - Manual Zerrow upload marks the photo as user-uploaded.
     - CardDAV/iPhone photo sync skips saving photos that match any known company-logo hash.
     - Google Contacts pull skips saving photos that match any known company-logo hash.
     - Company-logo fallback rendering records the logo hash for future echo detection.

2. Stop the UI flicker deterministically
   - In `getContact`, treat any saved avatar that matches the contact company’s logo history as a stale company-logo snapshot.
   - When detected, automatically clear `avatar_url`, preserve the matched logo hash, and return no personal avatar so the company logo is the only rendered image.
   - Keep real personal photos working: user-uploaded photos and synced photos that do not match company-logo hashes will still display.

3. Clean up the existing Volkswagen data
   - Merge/reassign the duplicate Volkswagen-related records into the canonical `Volkswagen` company.
   - Move Bryan and other matching contacts/domains/tags from `Volkswagen Group of America Inc.` and `VW` to `Volkswagen`.
   - Normalize the linked contacts’ displayed company field to `Volkswagen`.
   - Clear Bryan’s stale saved avatar so it cannot flicker back again.

4. Fix company subgroup/label reconciliation
   - Harden auto-company subgroup reconciliation so company-linked contacts use the canonical `company_id` + company name, not stale free-text company names.
   - Ensure stale auto-generated subgroups like `Volkswagen Group of America Inc.` are removed or renamed during reconcile.
   - Re-run reconcile for the affected parent groups so Bryan’s labels collapse to the canonical Volkswagen label.

5. Add regression tests
   - Test that Google/CardDAV photo saves skip company-logo echoes.
   - Test that a legacy saved logo snapshot is self-healed and does not render as a personal avatar.
   - Test that duplicate company labels collapse to the canonical company name after reconciliation.