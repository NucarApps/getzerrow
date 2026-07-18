## Goal

Make **Company** a first-class entity in Zerrow. A company owns its own detail page (logo, domains, website, phone, address, industry/tags, description, optional linked contact group). Contacts pick from an existing company (combobox) or type a new one (creates on save). Every domain a member uses is auto-attached to the company — editable — and drives the logo fallback everywhere.

## Data model

New tables (all `user_id`-scoped, RLS to `authenticated` only, GRANTs included):

- `companies` — `id`, `user_id`, `name`, `name_key` (normalized for uniqueness), `website`, `phone`, `address_line1/2`, `city`, `region`, `postal_code`, `country`, `industry`, `description`, `linked_group_id → contact_groups.id`, `created_at`, `updated_at`. Unique `(user_id, name_key)`.
- `company_domains` — `id`, `user_id`, `company_id`, `domain`, `source` (`auto`|`manual`), `created_at`. Unique `(user_id, domain)` so a domain maps to exactly one company.
- `company_tags` — `id`, `user_id`, `company_id`, `tag`. Unique `(company_id, lower(tag))`.

Migrations to existing tables:

- `contacts` gains `company_id uuid REFERENCES companies(id) ON DELETE SET NULL` (nullable). The free-text `contacts.company` stays for display/back-compat; it's kept in sync when a company is linked.
- `contact_emails` trigger: on insert/update of a non-personal domain email, if the contact has `company_id`, upsert into `company_domains` with `source='auto'`.
- Data backfill in the migration:
  - For each distinct `(user_id, normalize(contacts.company))`, insert a `companies` row (name = most common casing).
  - Set `contacts.company_id` on every contact whose company matches.
  - Seed `company_domains` from members' `contact_emails` domains (skipping personal domains).
  - Seed `companies.website` from any member's `website` when unambiguous.
  - Merge existing `company_aliases` — every alias domain becomes a `company_domains` row on the same company as the primary.
  - Copy `company_profiles.description` (by name or domain key) into `companies.description`.
  - Backfill logo: `company_logo_choices` stays as-is, keyed by domain — every domain a company owns now resolves to the same choice via `company_domains`.

Deprecations left in place for one release: `company_aliases`, `company_profiles`. Reads switch to `companies` + `company_domains`; old tables become append-only mirrors so uninstalled clients don't break.

## Server functions (`src/lib/companies/`)

- `listCompanies` — id, name, domain count, contact count.
- `getCompany` — full row + domains + tags + members (id, name, email, avatar_url).
- `createCompany({ name })` — normalize, dedupe, return id. Used by the contact form on save.
- `updateCompany({ id, patch })` — website/phone/address/industry/description/linked_group_id.
- `renameCompany({ id, name })` — recomputes `name_key`; blocks on collision.
- `addCompanyDomain({ id, domain })` / `removeCompanyDomain({ id, domain })` — manual edits (`source='manual'` on add).
- `mergeCompanies({ sourceId, targetId })` — reassigns contacts, moves domains/tags, deletes source. Bumps CardDAV `resync_nonce` and `photo_etag` so iPhone refreshes logos.
- `setCompanyTags({ id, tags[] })`.
- `setContactCompany({ contactId, companyId | null | { newName } })` — the picker's save call. Auto-attaches the contact's non-personal email domains to the company.

## UI

- **Contact form (`ContactDetailView.tsx`, `contacts.scan.tsx`, new-contact drawer)**: replace the plain text input with a `CompanyCombobox` (shadcn Command + Popover). Shows existing companies with logo + domain count, keyboard-selectable; typing a novel name reveals a "Create ‘Foo’" row. On save we call `setContactCompany`.
- **Companies list** at `/contacts/companies` — searchable list with logo, name, domain count, contact count. "New company" button.
- **Company detail** at `/contacts/companies/$companyId` — header with logo (uses existing `CompanyLogo` + primary domain), inline-editable name/website/phone/address/industry, tags editor, domains list (add/remove chips, `auto`/`manual` badge), description textarea, linked contact group picker, members list linking to each contact. Actions: **Merge into…**, **Delete** (unassigns contacts, keeps them).
- **Contacts list**: existing company buckets now key off `company_id` when present (falls back to derived logic for legacy rows). Bucket header click opens the company detail page. `CompanyAliasesDialog` is superseded by the company detail Domains tab; existing button on the bucket header routes to `/contacts/companies/$id`.
- **CompanyLogo fallback**: `contactLogoDomain` prefers the contact's linked company's primary domain over the personal-email path, so an Aditya @gmail.com linked to Nissan resolves the Nissan logo (fixes today's "N" issue as a side effect).

## Sync side-effects

When a company's domains/logo change, bump `carddav_settings.resync_nonce` and clear `photo_etag` for every linked contact — reuses the existing helper. Google Contacts uses `updated_at` bumps on affected `contacts` rows the same way.

## Out of scope for this pass

- Sharing companies across users / team CRM.
- AI-driven company enrichment (already partly exists via `enrich-suggest`; not touching here).
- Public company profile pages (`/c/...`).

## Verify

- Old contacts with `company = 'Nissan'` all resolve to one Company row after migration; deleting a member does not drop the domain from the company.
- Creating a new contact with `company = 'Foo Corp'` (novel) creates the row and links it in one save.
- Editing a domain on the company page updates the logo for every member on the next contacts list render.
- Renaming a company cascades: contact rows show the new name, CardDAV bumps, iPhone pulls fresh cards on next sync.
- Merge combines two companies without losing any contacts, domains, tags, or description.
- Existing tests pass; add unit tests for `normalizeCompanyName`, the trigger that auto-attaches domains, and `mergeCompanies`.

## Rollout order

1. Migration (tables + backfill + trigger).
2. Server functions + tests.
3. `CompanyCombobox` + wire into the contact form.
4. Companies list + detail routes.
5. Switch contacts-list bucketing and logo fallback to `company_id`.
6. Deprecate `CompanyAliasesDialog` entry point (redirect to detail page).
