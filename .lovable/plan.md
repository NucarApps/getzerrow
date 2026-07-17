## What's happening

The "449 pulled" counter in the progress UI counts **every person Google returned** on this run. The 276 rows you see in Contacts is what actually landed in the `contacts` table. The gap is real and expected given the current rules — but the UI is misleading because it doesn't tell you *why* rows were dropped.

In `src/lib/google-contacts/pull.server.ts` → `applyPersonChanges`, each Google person is filtered before insert:

1. **No email → skipped.** `if (!parsed.email) continue;` — Zerrow keys contacts by email. Any Google contact that's phone-only, name-only, or a company card with no email address is discarded silently. This is almost certainly the bulk of the gap (typical Google address books have a lot of these).
2. **Duplicate email → merged.** If two Google people share the same email (personal + work card, family shared entries, etc.), the second one finds the first via `.eq("email", parsed.email.toLowerCase())` and just re-links to the existing contact instead of creating a new row.
3. **Insert errors → logged and skipped** (rare, but counted in "pulled").

DB confirms the shape: 276 contacts, 270 google_contact_links (6 contacts existed before Google sync and got merged in).

## The fix

Two parts, both frontend/reporting only — no change to what actually gets stored.

### 1. Track drop reasons in the pull

In `pull.server.ts`, extend the return type and count as we go:

- `created: number`
- `updated: number`
- `skipped_no_email: number`
- `merged_duplicate_email: number`
- `failed: number`

Increment inside `applyPersonChanges` at each existing branch (no new DB writes). Return them alongside `pulled` from `pullFromGoogle`.

### 2. Surface the breakdown

- Persist the last-run breakdown on `google_sync_state` (add nullable columns `last_pull_created`, `last_pull_updated`, `last_pull_skipped_no_email`, `last_pull_merged`, `last_pull_failed` — one migration).
- Write them at the end of a successful pull in `reconcile.server.ts` (wherever the pull result is currently consumed).
- In `src/routes/_authenticated/settings.google-contacts.tsx`, replace the single "Pulled N" line with:
  - **Imported:** created + updated
  - **Skipped (no email):** N — with tooltip "Google contacts without an email address aren't stored in Zerrow yet"
  - **Merged into existing:** N (only shown if > 0)
  - **Failed:** N (only shown if > 0)

The totals will add up to the "449" you saw, so the number stops feeling like a bug.

### Out of scope for this plan (ask if you want either)

- Actually **importing** phone-only / no-email Google contacts. Requires making `contacts.email` nullable and picking a new natural key (resource_name?). Bigger change — separate plan.
- A "View skipped" list showing which Google names were dropped. Requires storing them; happy to add if useful.

## Technical notes

- Files touched: `src/lib/google-contacts/pull.server.ts`, `src/lib/google-contacts/reconcile.server.ts`, `src/lib/google-contacts/state.server.ts` (types), `src/routes/_authenticated/settings.google-contacts.tsx`, one new migration for the 5 columns on `google_sync_state`.
- No change to encryption, RLS, or the pull/push logic itself.
- The progress reporter's `total` should switch from `persons.length + deletions.length` to `created+updated+skipped+merged+failed` so the progress bar matches the final numbers.
