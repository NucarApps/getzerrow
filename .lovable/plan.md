## Plan

I verified the current backend state before planning: Zerrow has 489 contacts, 456 Google-linked contacts, 31 unlinked contacts, 450 contacts still dirty for Google push, 395 photo-dirty links, 24 local labels/groups, and 23 Google-linked labels. The current sync account is enabled in `two_way` mode with Contacts access granted and no stored error.

### 1. Make the Google sync push Zerrow’s current state reliably
- Keep Zerrow as the authoritative source for contacts, labels, memberships, and photos.
- Ensure dirty contacts are pushed in bounded batches until the backlog drains instead of appearing “done” after only a few items.
- Make unlinked Zerrow contacts eligible for creation in Google so the count can rise above the current ~405/456 linked set.

### 2. Fix label/group membership sync
- Wire the existing Google group membership push helper into the main sync flow; it currently exists but is not called from `pushToGoogle`, which explains why Google groups can stay old.
- After creating/updating contacts and labels, refresh the contact/group link maps before pushing memberships so newly-created Google contacts can be added to the correct Google groups in the same run.
- Add structured logs/counts for group membership add failures so a specific stuck label can be traced.

### 3. Add a “Zerrow source of truth” sync mode in settings
- Add an explicit settings mode that pushes Zerrow → Google while still allowing a manual Google import/backfill when needed.
- Make the current account use this source-of-truth behavior so old Google-side labels do not keep re-overwriting Zerrow’s labels.
- Update the settings copy/status to show backlog counts: unlinked contacts, dirty contacts, photo-dirty contacts, and pending group memberships.

### 4. Harden photo push draining
- Keep the existing photo failure details, but make the worker prioritize real photo changes without starving normal contact/body updates.
- Preserve the personal-vs-company photo priority resolver when pushing to Google and when serving CardDAV to iOS.

### 5. Add tests for the regression
- Add unit coverage around dirty-contact selection so unlinked and dirty contacts are not skipped.
- Add sync-level tests proving group memberships are pushed after contact/group creation and that source-of-truth mode does not pull old Google label membership back over Zerrow labels.

### 6. Verify after implementation
- Run the relevant tests.
- Check the database status after one sync run to confirm the dirty/unlinked counts drop and group membership links are being attempted/pushed.
- Use the settings/admin status to confirm sync progress and any specific Google API errors are visible.