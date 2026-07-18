## Problem

Erica's `contacts.avatar_url` holds bytes of the **Nissan** logo (a stale company-logo snapshot from a previous mis-association or CardDAV round-trip). Her contact is now correctly linked to Fenway Sports (`fenwaysports.com`, FSG logo chosen). The existing "Fix company logo photos" cleanup only clears an avatar when its bytes exactly match her *current* company's chosen logo, so a Nissan-logo snapshot on an FSG contact is never detected and stays pinned as her personal photo.

## Fix

### 1. Broaden the batch cleanup (`src/lib/contacts/company-logo-cleanup.functions.ts`)

For each contact with a company-linked `avatar_url`:

- Hash the stored avatar bytes once.
- Compare against the SHA of the contact's own chosen company logo (existing behavior).
- **New:** also compare against a per-user set of "known company-logo SHAs" — computed by fetching bytes for every domain in the user's `company_logo_choices` (and the primary domain of every company the user owns). Cache SHAs in-memory per run.
- If the avatar SHA matches ANY known company-logo SHA, clear `avatar_url`, delete the storage object, and stamp `company_logo_photo_sha` with the *current* company's logo SHA so CardDAV round-trips stay non-destructive.

This catches Erica (avatar = Nissan logo, matches the Nissan entry in the known-logos set) even though her contact is now under FSG.

### 2. Per-contact "Reset to company logo" action (`src/components/contacts/ContactPhotoUploader.tsx` + a new server fn)

Add a small menu item / button next to Remove, visible only when the contact has a `company_id`. It calls a new `resetContactToCompanyLogo` server fn that unconditionally clears `avatar_url` for that one contact, deletes the storage blob, sets `company_logo_photo_sha` to the current logo's SHA, and bumps the CardDAV resync nonce. This is an escape hatch for any future stale-snapshot cases where the batch heuristic can't identify the bytes.

### 3. Re-run

After deploying, the user clicks "Fix company logo photos" once more; Erica's stored Nissan bytes match the known-logos set and get cleared. Her drawer then falls back to the live FSG company logo. iPhone re-pulls on the next CardDAV sync.

## Technical notes

- Known-logos SHA set is built once per batch call: read `company_logo_choices` for the user, call `fetchChosenCompanyLogoBytes` for each domain, hash with `sha256Hex`. Failures per domain are skipped, not fatal.
- No schema change needed; `company_logo_photo_sha` already exists.
- The per-contact reset fn uses `requireSupabaseAuth` and scopes by `user_id` + `contact_id`.
- No UI change to `CompanyLogo`; the fallback path already works once `avatar_url` is null.

## Files touched

- `src/lib/contacts/company-logo-cleanup.functions.ts` — add known-logo SHA set + broadened match, add `resetContactToCompanyLogo` server fn.
- `src/components/contacts/ContactPhotoUploader.tsx` — add "Reset to company logo" affordance when `companyDomain` is present and `avatarUrl` is set.
- `src/components/contacts/ContactDetailView.tsx` — pass `companyId` through so the reset fn has an id to call with (only if not already threaded).
