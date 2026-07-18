## Goal
Clean up the duplicate contact labels once and stop new ones from being created going forward, with the same UX pattern we already use for company duplicates.

## 1. One-time "Find duplicate labels" drawer
- New `src/components/contacts/LabelDuplicatesDrawer.tsx` modeled on `CompanyDuplicatesDrawer`.
- Server functions in a new `src/lib/contacts/label-duplicates.functions.ts`:
  - `findDuplicateLabels({ useAi })` — clusters `contact_groups` by:
    - Identical `normalize_company_name(name)`
    - Same `company_id` (labels auto-created for the same company)
    - Name matches a `company_name_aliases` entry that resolves to the same company
    - If `useAi` on: pass remaining fuzzy candidates through Gemini for near-match clustering (same toggle UX as company drawer).
  - `mergeLabelCluster({ canonicalId, foldIds })` — moves `contact_group_members` (dedupe on `(group_id, contact_id)`), moves `contact_group_rules` (dedupe on `(group_id, rule_type, value)`), reparents children whose `parent_group_id` is in `foldIds`, deletes the losers, then calls the existing `reconcileAutoParentsForContacts` so CardDAV/labels update.
- Add "Find duplicate labels" button on `src/routes/_authenticated/contacts.index.tsx` next to the existing labels UI.

## 2. Auto-merge legacy auto-company subgroups
- One-shot server function `consolidateCompanyLabels()`:
  - Groups all `contact_groups` where `company_id IS NOT NULL` by `company_id`, keeps the oldest (or the one whose name matches the company's canonical name), folds the rest via `mergeLabelCluster`.
  - Also folds labels whose free-text name matches a `company_name_aliases.alias` for a company that already has a canonical label.
- Runs automatically once after this deploy (idempotent). Exposed as a "Consolidate now" button in the drawer for future runs.

## 3. Block new duplicates going forward
Single choke point: a new helper `findOrCreateContactGroup(userId, { name, companyId, parentId })` in `src/lib/contacts/group-resolve.server.ts`:
- If `companyId` provided → return existing label for that `company_id` (create only if none).
- Else normalize name via `normalize_company_name`; look up existing label by normalized name; check `company_name_aliases` to redirect variants ("VW" → Volkswagen's canonical label).
- Only insert when no match found.

Route every current call site through it:
- `src/lib/contacts/auto-company-subgroups.functions.ts` (main offender)
- `src/lib/carddav/handlers.server.ts` (iPhone-created groups)
- `src/lib/google-contacts/*` (Google Contacts pulls)
- `src/lib/contacts/group-rules.functions.ts` and any group-suggestion apply paths
- Any AI enrichment path that touches labels

DB safety net: add a partial unique index on `contact_groups (user_id, company_id)` where `company_id IS NOT NULL` so two labels can never point at the same company again.

## 4. Bulk actions on the labels list
On `contacts.index.tsx` labels section:
- Multi-select checkboxes per label.
- Bulk bar: **Merge into…** (picker of remaining labels, calls `mergeLabelCluster`), **Rename**, **Delete** (with member-count confirmation).

## Out of scope
- Rule engine changes (rules keep working; they're just moved during merges).
- Company merging (already handled by the company duplicates drawer).
- Any change to CardDAV group-display style settings.

## Technical notes
- Reuse `normalize_company_name` SQL function and `company_name_aliases` for matching so labels and companies stay aligned.
- Merges are transactional at the RPC level per cluster; UI shows count of members/rules moved.
- After every merge/consolidate, invalidate `["contact-groups"]`, `["contacts"]`, and bump the CardDAV `resync_nonce` so iPhone re-pulls clean labels.
- AI clustering uses the existing Lovable AI gateway with Gemini, same prompt shape as `findDuplicateCompanies`.
