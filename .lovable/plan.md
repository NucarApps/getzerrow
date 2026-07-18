## Goal

Reorganize the "edit company" dialog (`CompanyAliasesDialog`) into tabs and add a new **Description** field. All existing capabilities (rename, primary domain, aliases, logo, groups/tags) stay — they just move into a tabbed layout.

## Tab layout

```text
┌─ Edit company ──────────────────────────────────┐
│  [ Details ] [ Domains ] [ Logo ] [ Groups ]     │
├─────────────────────────────────────────────────┤
│  (tab content)                                   │
└─────────────────────────────────────────────────┘
```

- **Details** — Company name (inline rename, already exists) + new Description textarea.
- **Domains** — Primary domain (or "Add primary domain" for name-only buckets) + merged aliases list + add/promote/remove.
- **Logo** — Brand search, per-domain provider tiles.
- **Groups** — Tag chips with partial-membership indicators + Save tags.

Footer keeps `Delete merge` (when aliases exist) + `Close`.

## New: company description

- New table `public.company_profiles`:
  - `user_id uuid`, `key_type text ('domain'|'name')`, `key_value text` (domain like `nissan.com`, or normalized name like `nissan`), `description text`, timestamps.
  - Primary key `(user_id, key_type, key_value)`.
  - Standard RLS + GRANTs (authenticated: full CRUD scoped to `auth.uid()`; service_role: all).
- Server functions in `src/lib/contacts/company-profile.functions.ts`:
  - `getCompanyProfile({ domain?, nameKey? })` → `{ description }`.
  - `upsertCompanyProfile({ domain?, nameKey?, description })`.
- Key resolution in the dialog:
  - Has primary domain → key on `('domain', primaryDomain)`.
  - Name-only bucket → key on `('name', normalizeCompanyName(companyName))`.
- Description is plain text, up to ~2000 chars, textarea with autosave-on-blur (small "Saved" indicator), same pattern as inline rename.

## UI details

- Use existing shadcn `Tabs` component. Default tab: `Details`.
- Disable `Logo` and `Domains → aliases` tabs' editing affordances (show inline hint) when there is no primary domain yet, matching current behavior — Details and Domains-primary tabs stay usable so the user can set name/description/primary domain.
- Preserve all current server-fn calls; no changes to alias, logo, group, or rename logic.

## Files touched

- New migration: `supabase/migrations/<ts>_create_company_profiles.sql` (table + RLS + GRANTs).
- New: `src/lib/contacts/company-profile.functions.ts` (get/upsert server fns).
- Edit: `src/components/contacts/CompanyAliasesDialog.tsx` — wrap sections in `Tabs`, add Details tab with description textarea, wire description query/mutation.
- No changes to contact-bucket logic, migrations to `contacts`, or Google sync.

## Out of scope

- Cross-bucket rollups of description (each bucket has its own row).
- Rich-text / markdown editing for description (plain text only).
- Surfacing description elsewhere (contact list, contact detail) — this plan only stores + edits it in the dialog. Wire into other views in a follow-up if wanted.

## Clarifying question

Description scope — one shared description per **company** (keyed by primary domain / normalized name so all buckets that resolve to the same company see it) is what this plan does. Confirm that's what you want, or should it instead be per-**bucket** (e.g., "Nissan" name-key and "nissan.com" domain-key store separate descriptions even after you set the primary domain)? I'll default to shared unless you say otherwise.
