## Goal
Introduce a photo priority setting — global default, per-company override, per-contact override — that decides whether Zerrow shows the person's photo or the company logo first. Precedence: **contact > company > global**, default = **company first**. The chosen priority is also what gets pushed to iOS (CardDAV) and Google Contacts.

## Data model (one migration)

Add three enum-typed columns; `NULL` at contact/company means "inherit".

```sql
CREATE TYPE public.photo_priority AS ENUM ('company_first','personal_first','personal_only');

ALTER TABLE public.carddav_settings
  ADD COLUMN photo_priority public.photo_priority NOT NULL DEFAULT 'company_first';

ALTER TABLE public.companies
  ADD COLUMN photo_priority public.photo_priority;   -- NULL = inherit global

ALTER TABLE public.contacts
  ADD COLUMN photo_priority public.photo_priority;   -- NULL = inherit company/global
```

Existing rows get the `company_first` default globally; company/contact overrides start `NULL` so behavior matches today for anyone who had a personal photo (contact override defaults to inheriting company_first → company logo wins).

## Server: single resolver

New helper `src/lib/contacts/photo-priority.server.ts`:

- `resolveEffectivePriority({ contactPriority, companyPriority, globalPriority })` — pure precedence function.
- `resolveEffectivePhoto(contactRow, companyRow, settingsRow)` — returns `{ kind: "personal"|"company"|"initials", bytesUrl, hash }` by combining the priority with existing `avatar_url` / company `logo_url` / domain-resolved logo. Reuses `loadContactPhotoBytes` and the domain-logo path already in `logo-photo.server.ts`.

Use this resolver in:

1. `src/lib/contacts/crud.functions.ts` `getContact` — replace the current company-first heuristic with the priority-aware resolver. Also return the effective priority and its source (`contact` / `company` / `global`) so the UI can label the override.
2. `src/lib/carddav/handlers.server.ts` — vCard `PHOTO` writes use the resolver's chosen bytes.
3. `src/lib/google-contacts/push.server.ts` — photo push loop calls the resolver and uses its bytes + hash (already the shape it wants). "Personal only" contacts stop pushing the company logo.
4. `src/lib/google-contacts/push-photo-now.functions.ts` — same resolver; the "no photo" toast still fires only when the resolver returns `initials`.

Anywhere that already reads `avatar_url` directly for sync stays as-is (source of truth for personal bytes); only the "what should the outside world see" decision funnels through the resolver.

## Server: writes

Add three `createServerFn`s in `src/lib/contacts/photo-priority.functions.ts`, all `.middleware([requireSupabaseAuth])`:

- `setGlobalPhotoPriority({ priority })` → updates `carddav_settings`.
- `setCompanyPhotoPriority({ companyId, priority | null })` → updates `companies.photo_priority` (null clears override).
- `setContactPhotoPriority({ contactId, priority | null })` → updates `contacts.photo_priority`.

Each write marks the affected contact(s) photo-dirty for Google + bumps CardDAV CTag so iOS re-pulls, via existing `markGoogleContactPhotoDirty` / CardDAV resync helpers.

## UI

- **Global**: new "Photo preference" section on the existing contact settings page (three-way radio: Company first · Personal first · Personal only).
- **Company** (`src/routes/_authenticated/companies.$id.tsx`): small "Photo shown to me and my devices" select — `Inherit (…)` / Company first / Personal first / Personal only.
- **Contact** (`src/components/contacts/ContactDetailView.tsx`, near the photo uploader): same select with `Inherit from company` default. Show a hint chip like "Showing: Company logo (from company override)" so it's clear what wins.
- `CompanyLogo.tsx` / `ContactPhotoUploader.tsx` — no logic change; they just receive the URL/`photoUrl` the resolver picked (already the prop shape).

## Tests

`src/lib/contacts/photo-priority.test.ts`:
- Precedence: contact override beats company override beats global.
- `company_first` returns company bytes when both exist.
- `personal_first` returns personal bytes when both exist, falls back to company.
- `personal_only` never returns company bytes (falls to initials).
- Google push and CardDAV write both consume the resolver output (light spy test).

## Out of scope

No change to how domain logos are discovered, how personal photos are uploaded, or the iOS "echo" guard. No new storage buckets. No UI redesign beyond the three settings controls.
