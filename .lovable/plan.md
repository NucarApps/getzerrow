## Part 1 — Fix AI duplicate scan returning 0 suggestions

Root cause (most likely, based on `dedup.functions.ts`):
- `buildClusters` only groups by shared phone, exact `name|company`, or exact `name`. Contacts with distinct emails and no shared phone never form clusters, so the scan runs, analyzes 0 clusters, and inserts 0. Very common now that many synced Google contacts have unique names and no phones.
- The scan output toast currently says "Analyzed 0 of 0 clusters — 0 suggestions" and the drawer stays empty.

Fixes in `src/lib/contacts/dedup.functions.ts`:
1. Add three more blocking keys before the AI step:
   - `email_localpart`: same local-part (`joe.smith` in `joe.smith@x.com`) with different domains → strong dup signal.
   - `name_email_local`: normalized full name + email local-part.
   - `loose_name`: name normalized to first+last tokens (drop middles, punctuation, case) — catches "John A Smith" vs "John Smith".
2. Lower `MAX_CLUSTERS` cap to 80 and dedupe overlapping clusters (same id-set) so we don't waste AI credits.
3. When AI is unavailable or the cluster is only a `loose_name` signal, still surface as low-confidence so the user can see something.
4. Return `{ signalsSeen: {...} }` in the toast payload so the UI can say "No look-alike contacts found" vs "Ran but AI declined all".

## Part 2 — Fix AI group suggestions returning 0

Root cause (from `suggest-groups.functions.ts`):
- Model id `google/gemini-3.5-flash` is Gemini-3.5-Flash with strict structured-output enforcement. The `AiOutput` schema has `nullable` string fields inside a nested array, which Gemini frequently rejects post-hoc → `NoObjectGeneratedError` → the current catch returns `suggestions: []` silently.
- Even when it parses, `minMembers` = 3 for new/subgroup drops most real clusters when the pool is 1500 contacts spread across many companies.

Fixes:
1. Swap model to `google/gemini-3.1-flash-lite` (per `cloud-ai-models`, cost-efficient + reliable for classification/extraction) — matches what dedup should also use.
2. Loosen `AiOutput`: replace `.nullable()` string fields with `.nullish()` (Gemini treats these as truly optional) and keep the "no bounds" rule.
3. Drop the silent early-return in the `NoObjectGeneratedError` catch: log the raw text length and set a `stats.reason` so the toast can say "AI returned unparseable output" instead of "found 0".
4. Lower `minMembers` to 2 for new/subgroup (still 2 for merge). Cap total kept to 20.
5. Include `stats` in the toast: `Parsed X, kept Y (dropped: unknown_ids=A, too_small=B, duplicates=C)` so a 0-result run tells the user *why*.

## Part 3 — New: AI contact enrichment suggestions

New drawer "Enrichment suggestions" on the contacts page, alongside AI groups and Duplicates.

Scope (from your answers):
- Contacts with a name but no email → find email via sent/received participants.
- Contacts with only a phone → fuzzy-name match (strictness 3/5, i.e. same normalized first+last, or first-initial+last with same domain).
- Contacts missing company/title → run the existing `enrichContact` pipeline (email signatures) and offer the extracted fields.

Always-suggest flow: nothing is written until you click "Apply". Bulk "Apply all high confidence" button.

### New files / server fns

New file `src/lib/contacts/enrich-suggest.functions.ts` with:
- `scanContactEnrichment` — server fn (`requireSupabaseAuth`):
  1. Load contacts missing at least one of `email`, `company`, `title`, or with only phones.
  2. For each "name-only" contact, query `email_search_index` participant tsv for their normalized name (weight A) via existing `search_emails_participants`; take the top ≤5 distinct `from_addr` matches whose decoded `from_name` fuzzy-matches (Levenshtein via `fast-levenshtein` — cheap, no AI). Confidence: exact match = high, first+last = medium, fuzzy = low.
  3. For each "phone-only" contact, do the same but also match by digits-only phone in body text via a targeted `search_emails` query.
  4. For each contact missing `company/title` that DOES have an email, reuse the existing `enrichContact` extraction pass but write results to a *suggestion* row instead of the contact.
  5. Insert rows into new `contact_enrichment_suggestions` table.
- `listContactEnrichmentSuggestions` — pending rows joined with contact preview.
- `applyContactEnrichmentSuggestion` — writes the selected fields to the contact via existing `setContactEncryptedFields` for phone, plain update otherwise.
- `dismissContactEnrichmentSuggestion`.

### New table (single migration)

```sql
CREATE TABLE public.contact_enrichment_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  kind text NOT NULL,               -- 'email' | 'phone' | 'company' | 'title'
  suggested_value text NOT NULL,
  confidence text NOT NULL,         -- 'high' | 'medium' | 'low'
  source text NOT NULL,             -- 'name_match' | 'phone_match' | 'signature'
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, contact_id, kind, suggested_value)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_enrichment_suggestions TO authenticated;
GRANT ALL ON public.contact_enrichment_suggestions TO service_role;
ALTER TABLE public.contact_enrichment_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rows" ON public.contact_enrichment_suggestions
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX ON public.contact_enrichment_suggestions (user_id, status, confidence);
```

### New UI

`src/components/contacts/EnrichmentSuggestionsDrawer.tsx` — mirrors the duplicate drawer:
- "Run enrichment scan" button (rate-limited 5min like groups)
- Grouped by contact card; each field suggestion has confidence badge, evidence preview ("Found in email from Acme Motors 3 emails ago"), Apply / Dismiss.
- "Apply all high-confidence" bulk button.
- Add an entry point button in `src/routes/_authenticated/contacts.index.tsx` next to the existing AI groups / Duplicates buttons.

## Technical notes
- Use `google/gemini-3.1-flash-lite` for both scans (dedup AI judgment and group suggestions) per `cloud-ai-models`.
- Enrichment scan does NOT call AI for the name/phone matching step (deterministic + Levenshtein); AI is only invoked for the signature extraction path where we already have `enrichContact`.
- Reuse existing `normalizePhone` and add a `normalizeName` in `src/lib/contacts/phone.ts` sibling `name-match.ts` (first+last tokens, strip punctuation, unicode fold).
- Rate limit each scan to 1/5min per user, matching existing group-scan cooldown.
- All new server fns use `requireSupabaseAuth`; writes go through the user's RLS-scoped client except deletes/updates on suggestion rows.
