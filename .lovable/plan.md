## What's happening

Chanell Dagesse (`a4a43ddb…`) has one email in Zerrow (`chanelldagesse@gmail.com`) and two on iOS. The DB shows a single `contact_emails` row for her, backfilled at the exact moment the `contact_emails` migration ran — meaning the second email never made it into the new table.

Two facts explain why:

1. **When the `contact_emails` table shipped, the backfill only copied the single legacy `contacts.email` column.** There was nowhere else to source secondary emails from at that point, so any "extras" that existed only on iOS or Google were not created.
2. **Since the multi-email CardDAV/Google code landed, no fresh sync has actually brought the second email in yet.** iOS only sends a `PUT` for a contact when the user edits it. Chanell hasn't been touched on iOS since the fix, so iOS still hasn't re-sent her full vCard with both emails. Meanwhile her Google link is marked *dirty* (`last_synced_at = 1970`) from the earlier CardDAV edit, which means the next Google sync will **push** her (one-email) local record **up** to Google — and if Google has the second email, that push would erase it before we ever pulled it.

So the second email is stranded on iOS/Google, and the current sync direction is set up to overwrite it, not import it.

## What to do

Two independent fixes: one to recover Chanell right now, one so no other contact silently loses a secondary email.

### 1. Recover the missing email(s) safely

- Add a "Re-pull from Google" action on the contact drawer (and a bulk version in Settings → Google Contacts sync) that:
  - Clears the dirty flag on `google_contact_links` for the selected contact(s) (`last_synced_at = now()` sentinel that means "trust remote"), then
  - Runs a **pull-only** fetch of just those `resource_name`s from People API and writes results through the updated `personToContact` mapper (which already handles multi-email).
  - Never pushes during this action, so if Google has more than we do, we import it instead of clobbering it.
- Show the user a one-line result: "Imported N additional emails / phones from Google."
- For iOS-only extras (email exists only on iPhone, not in Google): show a small inline hint in the contact drawer when `contact_emails` has fewer rows than we've seen in past vCards, telling the user "open this contact on iPhone and tap Done to resync." That's the only reliable way to get iOS to re-`PUT`.

### 2. Backfill scan across all contacts

- One-shot server function `backfillMultiEmailsFromGoogle`, runnable from the admin/sync settings page, that:
  - Iterates every `google_contact_links` row for the user,
  - For each, pulls the current Google Person,
  - If Google's email list has any address not present in `contact_emails` for that contact, inserts the missing rows (never deletes, never touches the primary flag).
- Runs in batches with the existing lease/progress reporter so a large address book doesn't stall.
- Logs a summary: `{ contacts_scanned, emails_added, contacts_updated }`.

### 3. Prevent this from happening again on the next dirty push

- In `push.server.ts`, before pushing a "dirty" contact to Google, do a lightweight `people.get` first and compare email sets. If Google has any email address we don't have locally, **abort the push for that contact** and mark it for pull instead (flip `last_synced_at` back to a pull sentinel and log a warning). This turns a silent overwrite into a caught conflict.

### Technical notes

- No schema changes. `contact_emails` already exists with the correct shape and RLS.
- Reuses `personToContact` (already returns `emails: LocalEmail[]`) and the existing `contact_emails` upsert path from `pull.server.ts`.
- New server functions live in `src/lib/google-contacts/repair.functions.ts` behind `requireSupabaseAuth`, scoped by `userId`.
- UI additions: one button in `ContactDetailView.tsx`, one button + result panel in the Google Contacts settings section.

### What to verify after implementing

- Run "Re-pull from Google" on Chanell → `contact_emails` should have both addresses, primary preserved.
- Trigger CardDAV `GET` for Chanell (or refresh on iPhone) → vCard contains both `EMAIL` lines.
- Confirm no other contact regressed (spot-check 3 random contacts).
- Confirm the push-conflict guard fires for a synthetic case where Google has an extra email.

## Open question

Do you want the pull-only recovery to be automatic on next sync for every dirty contact (safer, slower), or only on-demand via the button (faster, requires you to click)? I'd default to on-demand plus the push-time conflict guard, but let me know if you'd rather have the automatic sweep.