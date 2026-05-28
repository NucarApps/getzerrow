# At-rest encryption for email and contact content

Goal: every piece of user-readable content Zerrow stores is encrypted at rest with a server-held key, while in-transit encryption (TLS 1.2+) and in-app search both keep working.

## What gets encrypted

Convert these plaintext columns to `bytea` (pgcrypto AEAD), one ciphertext per column:

- `emails`: `subject`, `snippet`, `body_text`, `body_html`, `ai_summary`, `from_name`, `to_addrs`, `cc`, `classification_reason`
- `folder_examples`: `subject`, `snippet`
- `reply_drafts`: `draft_text`
- `contacts`: `notes`, `relationship_summary`, `address_line1`, `address_line2`, `phone`

Left as plaintext on purpose (needed for routing, joins, dedupe, deliverability):
`emails.from_addr`, `emails.gmail_message_id`, `thread_id`, `list_id`, `in_reply_to`, `raw_labels`, `received_at`, all `*_id` and boolean flags.

Key source: existing `EMAIL_ENC_KEY` secret (already used for OAuth tokens). Add a `key_version smallint NOT NULL DEFAULT 1` column on every encrypted table so we can rotate later without a schema change.

## How search keeps working

Add an encrypted-but-searchable sidecar so the UI can still do "search my inbox" without ever putting plaintext content back on disk:

- New table `email_search_index(email_id uuid PK, user_id uuid, tsv tsvector, GIN index)` — built server-side from the decrypted subject+snippet+body at write time. RLS scoped to `auth.uid()`.
- `tsv` is a derived token vector, not the plaintext. It leaks token shape (standard tradeoff for any searchable encryption that isn't fully homomorphic) but not raw bodies.
- Search server fn: takes the user's query, builds a `tsquery`, returns matching `email_id`s, then a second decrypt-and-return step in the same server fn streams back the rendered rows.

For filter-engine matches on subject/body, the engine already runs server-side in `process-message` — it just receives decrypted strings from the new RPC instead of reading the columns directly. No client change.

## Database changes (one migration per phase; backfill is a job, not a migration)

Phase 1 — schema + RPCs (additive, dual-write):
1. Add `_enc bytea` and `key_version smallint` columns next to each target column (e.g. `subject_enc`, `body_text_enc`). Keep the plaintext columns for now.
2. Create `email_search_index` table + GIN index, RLS, GRANTs.
3. Create `SECURITY DEFINER` RPCs (mirroring the OAuth pattern):
   - `insert_email_encrypted(...payload..., p_key text) returns uuid` — encrypts + writes `_enc` columns + updates `email_search_index`.
   - `update_email_encrypted(p_email_id uuid, ...patch..., p_key text)`.
   - `get_emails_decrypted(p_ids uuid[], p_key text) returns table(...)` — bulk decrypt for list/detail views.
   - `search_emails(p_user_id uuid, p_query text, p_key text, p_limit int, p_offset int) returns table(...)` — uses `tsv @@ websearch_to_tsquery(...)`, returns decrypted rows.
   - Analogous helpers for `folder_examples`, `reply_drafts`, `contacts`.
4. Wire `process-message`, `classify`, `folder-learn`, `forward-retry`, reply-draft writer, and contact enrichment to call the new RPCs.

Phase 2 — backfill:
- New `encryption_backfill_jobs` table + a `/api/public/cron/encryption-backfill` route (CRON_SECRET-gated) that batches 500 rows at a time per table, reads plaintext, calls the encrypted RPC, marks the row, and yields. Idempotent; safe to re-run.

Phase 3 — flip reads + drop plaintext:
- Switch all server fns and the realtime UI path to read via `get_emails_decrypted` / `search_emails`. Components no longer touch `emails.body_text` directly.
- Once backfill reports 100% and no code references the plaintext columns, a follow-up migration drops them.

## Realtime

`emails` is on `supabase_realtime`. After Phase 1 it would broadcast `bytea` blobs subscribers can't decrypt, so:

- Drop the encrypted columns from the realtime publication; keep only metadata (`id`, `user_id`, `gmail_account_id`, `folder_id`, `is_read`, `is_archived`, `snoozed_until`, `received_at`, flags).
- `use-email-realtime.ts` treats the realtime event as a "something changed, refetch this id" signal and then calls `get_emails_decrypted([id])` via a server fn. UI behaviour is unchanged; only the transport changes.

## Server-fn surface (new files)

- `src/lib/email-crypto.functions.ts` — `listEmails`, `getEmail`, `searchEmails`, all `requireSupabaseAuth`, all call the new RPCs with `p_key = process.env.EMAIL_ENC_KEY`.
- `src/lib/contact-crypto.functions.ts` — same shape for contacts/reply drafts/folder examples.
- `src/lib/sync/encrypted-writer.ts` — single helper used by every ingest path; never write plaintext to the encrypted columns again.

Filter engine stays pure; it just receives the decrypted struct from `encrypted-writer.ts`.

## Privacy policy update

After Phase 3 ships, tighten `src/routes/privacy.tsx` to say email bodies, subjects, summaries, drafts, and contact notes are stored with column-level AEAD encryption using a server-held key, in addition to disk-level encryption. Until then, leave the current wording (which already distinguishes column-level from disk-level) as-is.

## Out of scope (call out explicitly)

- End-to-end / client-side keys: incompatible with server-side AI classification.
- Encrypting `from_addr`, message ids, or label arrays: needed in plaintext for filter joins, dedupe, Gmail API calls, and contact derivation.
- Automatic key rotation: `key_version` column is added now; the actual rotate job is a separate plan.

## Rollout order

1. Phase 1 migration + RPCs + ingest writes both plaintext and ciphertext (dual-write).
2. Backfill job runs to completion across all target tables.
3. Phase 3 migration: flip realtime publication, swap all readers to RPCs, drop plaintext columns, update privacy policy.

Each phase is independently shippable and reversible up to the Phase 3 drop.
