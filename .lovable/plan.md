## Plan

1. **Tighten the CardDAV write guard**
   - Update the CardDAV `PUT` handler so an incoming iPhone save can only clear an existing email when the vCard contains an explicit, non-empty replacement policy we trust.
   - For existing contacts, blank/missing email values will preserve the current server email instead of writing `null`.

2. **Protect against stale iPhone overwrites**
   - Add a small stale-write check: if iOS sends an older/partial card after the server already has a newer email, keep the newer email and only merge safe fields like name/phone/company.
   - Keep the Google contact link marked dirty so the saved email is pushed upstream later instead of pulled back down.

3. **Make diagnostics useful**
   - Keep structured logs for CardDAV `PUT`, including contact id, present fields, whether the request had an email value, and whether email was preserved.
   - Avoid logging private email values or vCard bodies.

4. **Add regression coverage**
   - Add tests for the exact iOS failure pattern: contact has an email, then a follow-up CardDAV `PUT` arrives with no email or blank email and must not clear it.
   - Keep the existing parser tests for blank `EMAIL`, `TEL`, and `ORG` lines.

5. **Force a clean iPhone refresh**
   - Bump the CardDAV resync/CTag nonce after the code fix so iPhone re-fetches the corrected vCards.