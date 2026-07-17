## Why the count doesn't match

- Google reports 459 contacts. Zerrow currently has 276 contacts, 270 of which are linked to a Google resource.
- The Zerrow `contacts` table requires a non-null email and uses `(user_id, lower(email))` as its uniqueness key.
- `src/lib/google-contacts/pull.server.ts` explicitly skips every Google person that has no primary email address (`if (!parsed.email) { breakdown.skipped_no_email++; continue; }`).
- Result: any Google contact that has only a phone, a name, or an address (very common for contacts imported from a phone) is dropped on the way in.

That's the whole gap. Nothing is stuck — those contacts are being seen and deliberately skipped by design.

## What to change

Let emailless Google contacts import into Zerrow, using the Google `resourceName` as the natural key when no email exists. Nothing about email-based merging or CardDAV changes for contacts that do have an email.

### Database migration
- Make `public.contacts.email` nullable.
- Drop the plain `contacts_user_email_key` unique index.
- Replace `contacts_user_email_unique` with a partial unique index so uniqueness only applies when email is present:
  ```sql
  CREATE UNIQUE INDEX contacts_user_email_unique
    ON public.contacts (user_id, lower(email))
    WHERE email IS NOT NULL;
  ```
- Backfill nothing (existing rows all have an email).

### Pull logic (`src/lib/google-contacts/pull.server.ts`)
- Remove the "no email → skip" branch. Instead:
  - If there's an existing `google_contact_links` row for this `resourceName`, update that contact as today.
  - If not and the person has an email, keep today's find-or-create-by-email path (merge into existing Zerrow contact).
  - If not and the person has no email, create a new contact with `email = null`, name/phones/company from the Google payload, `source = 'google'`, and immediately upsert the `google_contact_links` row so subsequent syncs update it in place.
- Reclassify counters: emailless creates count toward `last_pull_created` (not `skipped_no_email`). Keep `skipped_no_email` for anything we still can't import (e.g. no email and no name and no phone — pure ghost entries).

### Contacts UI (`src/routes/_authenticated/contacts*` and list components)
- Where we render a contact's email, fall back to the primary phone or "No email" when `email` is null so emailless rows are still readable and clickable.
- Ensure list queries don't filter on `email IS NOT NULL`.

### Settings card (`src/routes/_authenticated/settings.google-contacts.tsx`)
- Update the breakdown copy so "Skipped (no email)" reads "Skipped (no email, phone, or name)" — matches the tightened definition.

## Verification after build
1. Run "Sync now" (pull_only) for the affected account.
2. Confirm `last_pull_created` jumps by roughly the missing ~183 contacts and `last_pull_skipped_no_email` drops to a small number (pure ghost entries only).
3. Confirm `SELECT count(*) FROM google_contact_links WHERE gmail_account_id = 'adb85c80-…'` is close to 459.
4. Open Contacts in the UI and confirm the emailless entries render with name/phone.

## Out of scope
- Any change to CardDAV export, folder mapping, two-way push, or company grouping — emailless contacts flow through the existing pipelines unchanged.
- No change to the cadence picker or background cron behavior added in the previous turn.