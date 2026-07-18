## Goal
Support multiple email addresses per contact (like we already do for phones), so iOS/Google/manual entries with several emails round-trip instead of collapsing to one.

## Data model
Add `public.contact_emails` mirroring `contact_phones`:
- `id`, `user_id`, `contact_id` (FK), `label` (home/work/other/custom), `address` (text, lower-cased), `is_primary` (bool), `position` (int), `created_at`, `updated_at`.
- Unique `(contact_id, lower(address))`; index on `(user_id, lower(address))` for lookups.
- RLS scoped to `auth.uid()`, GRANTs to `authenticated` + `service_role`, `updated_at` trigger.

Keep `contacts.email` as the primary/canonical email (single source for search, dedupe, mail matching). On any write to `contact_emails`, mirror the primary row into `contacts.email` via trigger.

Backfill: for every existing `contacts` row with non-null `email`, insert one `contact_emails` row (`label='other'`, `is_primary=true`, `position=0`).

## CardDAV round-trip
- Parser (`src/lib/carddav/vcard.ts`): collect every non-empty `EMAIL` line into `parsed.emails: {label,address,is_primary}[]`, keep the existing empty-value guard so blank slots don't null anything.
- Builder: emit one `EMAIL` line per row, primary first with `TYPE=pref;PREF=1`, label mapping matches phones.
- Merge (`src/lib/carddav/merge.ts`) + `handlePut` (`handlers.server.ts`): apply the same non-destructive replace we use for `contact_phones` — only touch `contact_emails` when the PUT has at least one non-empty EMAIL; preserve rows on partial PUTs; still filter legacy `carddav+uuid@local.zerrow` placeholders.
- Bump `resync_nonce` so devices re-pull.

## Google Contacts
- Pull (`pull.server.ts`): replace "first email wins" logic with a full `contact_emails` upsert, primary = Google's `metadata.primary` (fallback first).
- Push (`push.server.ts`): send every row in `contact_emails`, primary marked, using existing dirty-flag logic.

## App surfaces
- `ContactDetailView.tsx`: render a list of emails with label chips + primary badge; add/remove/reorder/set-primary controls (same UX as phones).
- Manual add/edit (`crud.functions.ts`): accept `emails[]`; keep single-email inputs working by treating them as one primary row.
- Enrichment (`enrich-suggest.functions.ts`): when signature extraction finds new emails, suggest them as additional rows instead of replacing.
- Dedupe (`dedup.*`): match on any `contact_emails.address`, not just `contacts.email`.
- Search / email→contact resolution: query `contact_emails` first, fall back to `contacts.email`.

## Regression tests
Extend `src/lib/carddav/sync.regression.test.ts` and `merge.test.ts`:
- vCard with 2 EMAIL entries → both persisted, primary preserved.
- Follow-up PUT with only the primary → secondary is NOT deleted.
- Follow-up PUT with empty EMAIL slot → existing rows untouched.
- Google pull with multi-email person → all rows present, primary flag correct.

## Out of scope
- No changes to inbox classification or filter engine (they already work off `from_addr`).
- No UI for merging different contacts that share a secondary email — existing dedupe drawer will surface those.
