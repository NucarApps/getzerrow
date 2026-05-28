# At-rest encryption rollout — progress

In transit: already covered by TLS 1.2+ end-to-end (Cloudflare ↔ browser, Worker ↔ Google, Worker ↔ Supabase).
At rest: rolling out column-level pgcrypto AEAD with the existing server-held `EMAIL_ENC_KEY`, same pattern as the OAuth-token helpers.

## Phase 1 — DONE (migration `20260528_*_phase1_at_rest_encryption.sql`)

Foundation only. Additive, dual-write friendly: nothing breaks because plaintext columns are still populated and still read.

Schema:
- `emails`: added `subject_enc`, `snippet_enc`, `from_name_enc`, `to_addrs_enc`, `cc_enc`, `ai_summary_enc`, `classification_reason_enc`, `body_text_enc`, `body_html_enc`, `key_version`.
- `reply_drafts`: added `draft_text_enc`, `key_version`.
- `contacts`: added `notes_enc`, `relationship_summary_enc`, `address_line1_enc`, `address_line2_enc`, `phone_enc`, `key_version`.
- `folder_examples`: added `subject_enc`, `snippet_enc`, `key_version`.
- New table `email_search_index(email_id PK, user_id, tsv tsvector, GIN)` with RLS scoped to `auth.uid()`.

Helpers (`private` schema, `SECURITY DEFINER`, granted only to `service_role`):
- `private.encrypt_text(plaintext, p_key) → bytea` (pgp_sym_encrypt)
- `private.decrypt_text(ciphertext, p_key) → text` (pgp_sym_decrypt; returns NULL on failure)

RPCs (`public` schema, locked to `service_role`):
- `insert_email_encrypted(...payload, p_key) → uuid` — encrypts every sensitive column AND populates `email_search_index.tsv` from the plaintext subject/snippet/body before encryption.
- `update_email_encrypted(p_email_id, subject?, snippet?, body_text?, body_html?, ai_summary?, classification_reason?, p_key)` — NULL = leave unchanged; refreshes search index when subject/snippet/body change.
- `get_emails_decrypted(p_ids uuid[], p_key) → table(...)` — bulk decrypt for list/detail.
- `search_emails(p_user_id, p_query, p_limit, p_offset, p_key) → table(...)` — `tsv @@ websearch_to_tsquery(...)`, ranked, decrypted.
- `set_reply_draft_encrypted` / `get_reply_draft_decrypted`.
- `set_contact_encrypted_fields` (NULL = leave unchanged) / `get_contact_decrypted`.
- `insert_folder_example_encrypted` / `get_folder_examples_decrypted`.

## Phase 2 — DONE: route ingest writes through the RPCs (dual-write)

Migration `20260528_*_phase2_dual_write.sql` shipped: every encryption RPC now writes BOTH plaintext + `*_enc`. `upsert_email_encrypted` handles the main ingest path and refreshes the search index. Follow-up migration made `insert_folder_example_encrypted` upsert on `(folder_id, gmail_message_id)`.

Typed wrapper: `src/lib/sync/encrypted-writer.ts`.

Routed through wrappers in 2a + 2b:
- `src/lib/sync/process-message.ts` (2a)
- `src/lib/sync/reconcile.ts` — repair-update at line 126.
- `src/lib/sync/folder-learn.ts` — all three `folder_examples` upserts + both `emails.upsert` sites (learnFromLinkedLabel + loadOlderFromLabel).
- `src/lib/sync.server.ts` — batch AI classify update + per-message classify + classify-fail (lines 812 / 835 / 846).
- `src/lib/gmail.functions.ts` — search-ingest upsert (1853), scan-folder upsert (3060), and `reply_drafts.insert` (693).
- `src/lib/contacts.functions.ts` — enrichment update, manual update, business-card upsert, and addContactFromEmail patch now mirror sensitive fields (phone / notes / relationship_summary / address_line1 / address_line2) into the encrypted columns via `setContactEncryptedFields`.

Intentionally left direct (no sensitive text changes):
- Flag-only updates: is_read, is_archived, raw_labels, snoozed_until, forward_* — in reconcile, sync.server label-apply, resyncMessage, reconcileInboxFromGmail, forward-retry.
- contacts bulk import (lines 939 / 1048) — only writes email + name, no sensitive columns.
- folder_id-only / classified_by-only label echoes in sync.server.applyLabelChange.

Reads stay on plaintext columns through Phase 2.




## Phase 3 — IN PROGRESS: backfill legacy rows, then drop plaintext

Audit (rg over `from('emails'|'reply_drafts'|'contacts'|'folder_examples')` for `.insert/.update` of sensitive fields): clean — all remaining direct writes are flag-only (is_read/labels/forward_*) or non-sensitive bulk imports, as already documented in Phase 2.

3a — DONE: Server-side batch backfill RPCs (`backfill_emails_encryption`, `backfill_reply_drafts_encryption`, `backfill_contacts_encryption`, `backfill_folder_examples_encryption`), service-role only. Cron route `/api/public/encryption-backfill` (CRON_SECRET-gated) drains them in batches and refreshes `email_search_index` for legacy emails. Scheduled daily at 04:17 UTC (`encryption-backfill-daily`).

Starting state at deploy: 76,943 emails / 7 drafts / 40 contacts / 3,262 folder_examples lacking `*_enc`; 0 rows in `email_search_index`. Daily cron with default batch sizes (500×10 emails per run) drains the email backlog in ~16 days; tune via `?email_batches=` for a faster initial sweep, or invoke the route manually.

3b — TODO once backfill is fully drained (verify via `SELECT COUNT(*) FROM emails WHERE subject_enc IS NULL`): migration to drop the plaintext columns — `emails.{subject,snippet,body_text,body_html,from_name,to_addrs,cc,ai_summary,classification_reason}`, `reply_drafts.draft_text`, `contacts.{notes,relationship_summary,address_line1,address_line2,phone}`, `folder_examples.{subject,snippet}`. Read RPCs already `COALESCE(decrypt_text(...enc), <plaintext>)` so they keep working once the plaintext arg goes away, but the wrappers in `encrypted-writer.ts` and the dual-write RPCs must stop passing the plaintext column first.

3c — DONE: `src/routes/privacy.tsx` updated from "disk-level + OAuth tokens" to "column-level AEAD on bodies, subjects, summaries, drafts, and contact notes/phones/addresses".

## Out of scope

- pgsodium / managed key vault — not available on the current plan; pgcrypto + `EMAIL_ENC_KEY` is the established pattern.
- Client-side / end-to-end encryption — incompatible with server-side AI classification.
- Encrypting `from_addr`, gmail/thread/message ids, raw labels — needed plaintext for filter joins, dedupe, Gmail API calls, and contact derivation.
- Automatic key rotation — `key_version` column is in place; rotate job is a separate plan.
