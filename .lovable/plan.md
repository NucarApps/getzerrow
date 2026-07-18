## Problem

In `src/routes/_authenticated/contacts.index.tsx` (`companyBuckets`, lines 319–356), a contact is bucketed by the domain extracted from their email. If a contact has no email (e.g. Brad Taylor, phone-only), `extractDomain` returns null and the contact falls into the `__other__` bucket — even when `c.company` is filled in. That's why Brad shows up under "Other" instead of under his company.

## Fix

Before falling through to "Other", check whether the contact has a non-empty `company` field. If yes, bucket by that company name (keyed off `normalizeCompanyName(c.company)` so "Honda Inc" and "Honda" collapse together, matching the rest of the app's normalization). No domain, no logo — just a name-keyed company bucket that behaves like the domain-keyed ones.

New bucketing order inside the `for` loop:

1. Has real (non-personal) email domain → domain-keyed company bucket (unchanged).
2. Personal-domain email (gmail/yahoo/etc.) → Personal bucket (unchanged).
3. No domain BUT `c.company?.trim()` is set → company-name-keyed bucket:
   - `key = "name:" + normalizeCompanyName(company)`
   - `domain = null`, `name = company.trim()`, `kind = "company"`.
   - Same push/merge behavior as existing company buckets, so sorting, collapse, group multi-select, and the pencil/alias dialog all keep working.
4. Otherwise → "Other" (unchanged).

Downstream effects to verify (read-only checks, no other edits expected):

- Sort block at line 358–360 already treats every `kind === "company"` bucket the same, so name-keyed buckets sort alphabetically alongside domain-keyed ones.
- Same-name merge suggestions (lines 391–437) explicitly skip buckets without a domain (`!b.domain`), so they won't try to merge these name-only buckets — correct behavior.
- The company logo/pencil UI (line 747+) already branches on `b.kind === "company" && b.domain` for logo rendering, so name-only buckets will render with no logo but still show the header, contact list, and the rename dialog we just added.
- `CompanyAliasesDialog` receives `contactIds` from the bucket; renaming still works because `renameCompanyForContacts` updates the `company` column directly.

## Out of scope

- Not changing the Google Contacts pull, dedupe, or auto-subgroup logic.
- Not adding a logo/domain to name-only buckets.
- Not touching "Other" behavior for contacts that have neither email nor company.

## Files

- `src/routes/_authenticated/contacts.index.tsx` — only the `companyBuckets` `useMemo` (~lines 319–356). `normalizeCompanyName` is already imported (line 71).
