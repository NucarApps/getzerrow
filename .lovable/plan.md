Add two layers of contact deduplication so emailless duplicates stop inflating the count:

## 1. Deterministic merge on Google pull

Currently `src/lib/google-contacts/pull.server.ts` only merges by email — any emailless contact becomes a brand-new row, so re-pulls can multiply the same person.

Change the "no link, no email match" branch to also try these lookups against `contacts` + `contact_phones` (scoped to `user_id`, only against rows where `email IS NULL` to avoid stealing a real email-keyed contact):

1. **Any phone match** — normalize each phone (E.164 fallback: strip non-digits, keep last 10). If any existing emailless contact shares a normalized number → merge.
2. **Name + phone match** — if #1 finds multiple candidates, prefer the one where `lower(name)` also matches.
3. **Name-only fallback** — only when the Google person has no phone: match on exact `lower(name)` + same `company` among emailless contacts. Skip if ambiguous (2+ candidates) to avoid false merges.

Add a small helper `findEmaillessDuplicate({ userId, name, company, phones })` in a new `src/lib/contacts/dedup.server.ts`. Bump `breakdown.merged_duplicate_email` counter into two: `merged_by_email` and `merged_by_phone` (surface both in the sync UI counters block in `settings.google-contacts.tsx`).

## 2. AI-assisted duplicate review

New page/drawer to clean up existing duplicates (works whether they came from Google, CSV, or manual entry).

- Migration: `contact_duplicate_suggestions` table — `id`, `user_id`, `primary_contact_id`, `duplicate_contact_ids uuid[]`, `confidence` (`high|medium|low`), `reason text`, `signals jsonb`, `status` (`pending|merged|dismissed`), timestamps. RLS scoped to `auth.uid()`, GRANT to `authenticated` + `service_role`.
- Server fn `scanContactDuplicates` in `src/lib/contacts/dedup.functions.ts`:
  - Pulls all contacts for the user (id, name, company, email, phones via join).
  - **Blocking pass** (cheap): groups candidates by normalized phone, by `lower(name)`, and by `lower(name)+company`. Any group with 2+ members becomes a candidate cluster.
  - **AI pass** on ambiguous clusters (< ~200 clusters/run) using `google/gemini-3.5-flash` via Lovable AI Gateway. Prompt gives the model each cluster's contacts (name, company, title, email, phones, notes snippet) and asks it to decide `same_person: true|false` + `confidence` + short `reason`. Skip AI for high-signal exact phone matches — already write those as `high` confidence.
  - Writes results to `contact_duplicate_suggestions` with `status='pending'`, upserting on `primary_contact_id`.
- Server fn `mergeContactDuplicate({ suggestionId })`: picks the richest row as primary (most non-null fields, preferring one with email), moves group memberships / phones / google_contact_links to primary, deletes duplicates, marks suggestion `merged`. Server fn `dismissContactDuplicate` marks `dismissed`.

## 3. UI

Extend `src/components/contacts/GroupSuggestionsDrawer.tsx` pattern → new `DuplicateSuggestionsDrawer.tsx`:
- Toolbar button "Find duplicates" in `contacts.index.tsx` next to "Suggest groups".
- "Run AI scan" runs `scanContactDuplicates`; then lists clusters grouped by confidence.
- Each cluster shows side-by-side cards for the contacts, the AI's reason, and buttons **Merge**, **Keep separate**.
- On merge, invalidate contacts / groups queries and toast the reclaimed count.

## Technical notes

- Phone normalization: pure helper in `src/lib/contacts/phone.ts` (`digits.slice(-10)` when length ≥ 10, else raw digits) — reused by pull and dedup scan.
- Dedup scan runs on demand only (button); no cron. Cap AI cluster count per run at 50 to keep credits predictable; show "N more not analyzed" if truncated.
- AI schema stays tiny (`{ same_person: boolean, confidence: 'high'|'medium'|'low', reason: string }`) per cluster, batched — no bounded arrays in the schema.
- All new server fns use `requireSupabaseAuth` and only touch `supabaseAdmin` inside the handler after auth.

## Files

- New: `src/lib/contacts/phone.ts`, `src/lib/contacts/dedup.server.ts`, `src/lib/contacts/dedup.functions.ts`, `src/components/contacts/DuplicateSuggestionsDrawer.tsx`, migration for `contact_duplicate_suggestions`.
- Edited: `src/lib/google-contacts/pull.server.ts` (phone-match branch, split counters), `src/lib/google-contacts/reconcile.server.ts` (pass counters through), `src/routes/_authenticated/settings.google-contacts.tsx` (show `merged_by_phone`), `src/routes/_authenticated/contacts.index.tsx` (toolbar button + drawer wiring).
