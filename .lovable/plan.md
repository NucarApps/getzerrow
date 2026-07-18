## Plan: stop iPhone contact email edits from being wiped

### Goal
Make an email added or edited on iPhone persist on the server and not get reverted by the next CardDAV/Google Contacts sync cycle.

### What I found
- The CardDAV `PUT` handler now parses grouped iOS email fields and only updates `contacts.email` when an `EMAIL` field is present.
- The Google Contacts pull path updates other contact fields but does not currently update `contacts.email` for an existing linked contact.
- The Google Contacts push path skips pushing local changes when `contacts.updated_at <= google_contact_links.last_synced_at`; because the pull path updates `last_synced_at` after pulling, a recent CardDAV edit can be treated as already synced and never pushed upstream.
- The app currently stores one primary email on `contacts`; there is no separate multi-email table yet.

### Changes to implement
1. **Make CardDAV saves mark linked Google contacts as locally changed**
   - After a successful CardDAV save, if the contact has a Google contact link, set that link’s `last_synced_at` to a safe older value or otherwise mark it as pending so the two-way sync push lane does not skip it.
   - Keep this scoped to the saved contact only.

2. **Preserve and push the new email before any pull can overwrite it**
   - Update Google Contacts push logic so an edited local email is included in the People API payload.
   - Ensure the push skip check treats CardDAV-updated contacts as dirty even if a recent pull touched `last_synced_at`.

3. **Prevent stale Google pull data from clearing the local email**
   - In the Google Contacts pull path, update `contacts.email` for existing contacts only when the remote person actually has an email and it differs, or when conflict rules say remote should win.
   - Avoid replacing a newly added local email with `null` from an older/empty Google record.

4. **Fix nullable email typing in the mapper**
   - Adjust the local contact type and `contactToPerson` mapper so contacts without an email do not generate invalid Google email payloads.
   - Add coverage for “email added locally after Google link exists”.

5. **Add regression tests**
   - CardDAV parser test for iOS `itemN.EMAIL` with labels remains covered.
   - Add Google mapper/sync-level tests proving:
     - local email edits are included in push payloads,
     - an empty remote email does not wipe a newer local email,
     - linked contacts with CardDAV changes are not skipped as already synced.

### Validation
- Run the focused CardDAV and Google Contacts tests.
- Verify no placeholder `carddav+...@local.zerrow` email can be re-emitted.
- Confirm the save path returns a fresh ETag so iPhone sees the server-side saved version instead of reverting.