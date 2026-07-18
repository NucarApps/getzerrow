# Bulk enrichment rerun + contact avatar company-logo fallback

## Issue 1 — "Load failed" on bulk rerun

**Why it fails.** The current entry point in Settings → "Resync summaries now" only bumps `updated_at` so iOS/Google pick up the *existing* summary text — it does not actually rerun the AI. The path that does regenerate AI (`scanContactEnrichment`) tries to process up to 200 contacts (with up to 40 AI extractions) in a single HTTP call, and Safari kills the request at ~15–30s with the "Load failed" message.

**What we'll build.**

1. Rename the existing settings button to "Push existing summaries to devices" so its true behavior is obvious.
2. Add a new **"Rerun AI enrichment + summaries for everyone"** flow in Contacts settings that:
   - Loads the list of every contact id up front (one cheap query).
   - Processes them in small client-driven chunks of ~10 contacts per call, using a new `rerunEnrichmentBatch({ ids, force: true })` server fn. Each call stays well under Safari's wall-clock, so nothing gets dropped.
   - For each contact it runs the existing `enrichContact` logic with `force: true` (refreshes `relationship_summary` and any patchable fields), then queues a `scanContactEnrichment` pass at the end for suggestion rows.
   - Shows live progress ("142 / 380 contacts…"), lets the user cancel, and stores the last completed index so a refresh resumes rather than restarts.
   - After the last chunk, bumps the CardDAV resync nonce once so iOS pulls the new summaries.
3. Toast the failure count at the end and leave a "Retry failed" button that re-runs only the ids that errored.

## Issue 2 — Aditya's Nissan logo doesn't show on his contact card

**Why it doesn't show.** Aditya has `company_id` set to a Nissan company row that already has `nissanusa.com` in `company_domains`. The contact list correctly resolves the company's primary domain and renders the Nissan mark. The **contact detail avatar** (`ContactPhotoUploader`) does not — it only looks at the contact's own `website` / `email` fields to pick a logo domain, so a contact whose personal email isn't `@nissanusa.com` gets no logo fallback.

**What we'll build.**

1. Pass the linked company's primary domain (and the aliased/preferred logo domain) into `ContactPhotoUploader` from the contact detail drawer, using the same `companyDomainById` map the list already builds.
2. In `ContactPhotoUploader`, resolve the logo domain in this priority when there is no uploaded photo: linked company's primary domain → website domain → email domain. The existing `logoChoicesQuery` already covers the manual/auto provider mapping.
3. Do the same fallback in any other contact-card surfaces that currently pass only `website`/`email` (Contact drawer header, share preview) so behavior is consistent.
4. Do **not** override an uploaded `avatar_url` — the person's real photo still wins over the company logo.

## Technical notes

- New server fn: `rerunEnrichmentBatch` in `src/lib/contacts/enrich.functions.ts` — `.middleware([requireSupabaseAuth])`, input `{ ids: string[] (max 15), force: boolean }`. Iterates and calls the existing enrich helper per id inside a `Promise.allSettled`, returning `{ ok, failed: [{ id, error }] }`.
- Client driver in a new `useBulkEnrichmentRun` hook (React Query mutation queue) so progress state lives in one place and both the settings row and a toast can subscribe.
- Progress cursor stored in `localStorage` under `zerrow.bulkEnrich.cursor:<userId>` so a refresh resumes.
- Contact detail passes `companyDomain={companyDomainById.get(c.company_id)}` down to `ContactPhotoUploader`; the uploader accepts an optional `companyDomain` prop and uses it as the top-priority fallback.
- No schema changes.
