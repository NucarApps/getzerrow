## Goal

When a contact has no photo, fall back to the company logo the user *picked* in Zerrow (the selection stored in `company_logo_choices`), not just the first provider guess. That way every contact under Nissan gets the exact Nissan logo the user chose, on iPhone (CardDAV) and inside Zerrow.

## Current state (verified)

- `company_logo_choices(user_id, domain, provider, source_domain)` already stores the user's picked logo per company domain.
- `CompanyLogo.tsx` (in-app) already accepts `provider` + `sourceDomain` — but the contact avatar fallback path in `ContactPhotoUploader.tsx` and detail views doesn't pass them, so contacts under a picked company still show a generic provider guess or monogram.
- CardDAV `loadContactPhotoOrLogo` (`src/lib/carddav/handlers.server.ts`) → `fetchCompanyLogoBytes(logoDomainForContact(row))` in `src/lib/contacts/logo-photo.server.ts`. It walks providers in a fixed order and ignores `company_logo_choices` entirely, so the iPhone photo doesn't match what the user selected.

## Changes

1. **`src/lib/contacts/logo-photo.server.ts`**
   - Add `fetchChosenCompanyLogoBytes(userId, domain)` that:
     - Looks up `company_logo_choices` for `(userId, domain)`.
     - If a choice exists, fetches the single URL from `logoProviders(source_domain ?? domain)[provider]` (reusing `LOGO_PROVIDER_COUNT`/provider list — extract a shared `logoProviders(domain, size)` helper so client `logoCandidates` and server stay aligned).
     - Falls back to the existing multi-provider walk only when no choice is set.
   - Cache key becomes `${userId}:${domain}:${provider ?? "auto"}` so different users' picks don't collide.

2. **`src/lib/carddav/handlers.server.ts`**
   - `loadContactPhotoOrLogo` calls `fetchChosenCompanyLogoBytes(userId, domain)` instead of `fetchCompanyLogoBytes(domain)`.
   - Bump the address-book `resync_nonce` once on deploy (or when a user sets/changes a logo choice) so iPhone re-pulls contacts and picks up the new photo. Best approach: whenever `setCompanyLogoChoice` / `clearCompanyLogoChoice` succeeds, also bump `carddav_settings.resync_nonce` for that user (existing pattern used for other setting changes).

3. **`src/lib/company-logo.functions.ts`**
   - After `upsert`/`delete`, increment `carddav_settings.resync_nonce` so the phone resyncs affected contacts' photos.
   - Also clear stored `photo_etag` on `google_contact_links` for contacts under that company domain so the next Google Contacts sync pushes the newly picked logo (only when `use_company_logo_fallback` is on for that user).

4. **In-app contact avatar fallback** (`src/components/contacts/ContactPhotoUploader.tsx`, and any place using `CompanyLogo` for a contact avatar)
   - Load the user's `company_logo_choices` once (React Query on the contacts page / detail view) and pass matching `provider` + `sourceDomain` to `CompanyLogo` for the contact's domain — so Chanell shows the same Nissan logo the user picked, not the orange "C" or a different provider's image.

5. **No schema changes.** `company_logo_choices` and `carddav_settings.resync_nonce` already exist.

## Non-goals

- Not changing how the user picks a company logo (`CompanyAliasesDialog` flow stays as-is).
- Not touching the public `/api/public/logo` proxy — this is purely fallback resolution.
- Not letting per-contact photos be overridden (real avatar always wins).