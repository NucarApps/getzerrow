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

## Phase 2 — IN PROGRESS: route ingest writes through the RPCs (dual-write)

Migration `20260528_*_phase2_dual_write.sql` shipped: every encryption RPC (`insert_email_encrypted`, `update_email_encrypted`, `set_reply_draft_encrypted`, `set_contact_encrypted_fields`, `insert_folder_example_encrypted`) now writes BOTH plaintext + `*_enc`. New `upsert_email_encrypted` handles the main ingest path (on conflict gmail_message_id → update, refreshes search index). `update_email_encrypted` was extended to also accept `folder_id` / `ai_confidence` / `classified_by` / `matched_filter_ids` / `matched_folder_ids` so classify needs one call instead of two. All RPCs are still service_role only (key passed via `p_key`).

Typed wrapper module: `src/lib/sync/encrypted-writer.ts` — exports `upsertEmailEncrypted`, `updateEmailEncrypted`, `setReplyDraftEncrypted`, `setContactEncryptedFields`, `insertFolderExampleEncrypted`. Reads `EMAIL_ENC_KEY` once and forwards.

Done in 2a:
- `src/lib/sync/process-message.ts` — main upsert + repair-update + classify-update + classify-fail-update now go through the wrappers. Flag-only updates (is_read, is_archived, forward_*, raw_labels, snoozed_until) stay on direct `.update()`.

Pending in 2b (each is a focused edit on top of the same wrappers — no more migrations needed):
- `src/lib/sync/reconcile.ts` — three update sites at lines 126 / 174 / 218.
- `src/lib/sync/folder-learn.ts` — two `emails.upsert` sites (264, 389) → `upsertEmailEncrypted`; folder-example inserts → `insertFolderExampleEncrypted`.
- `src/lib/sync/classify.ts` — any direct email writes (mostly already goes through the return that process-message persists).
- `src/lib/sync/forward-retry.ts` — four flag/forward_* updates (safe to leave direct since no sensitive text changes); read path still pulls plaintext `body_text`/`subject` which is fine until Phase 3.
- `src/lib/sync.server.ts` — three sync update sites (485, 812, 835, 846); these mutate body/subject during reconcile, so route through `updateEmailEncrypted`.
- `src/lib/gmail.functions.ts` — upserts at 1853 (backfill insert) and 3047 (re-fetch) → `upsertEmailEncrypted`; update at 2104 / 2185 → `updateEmailEncrypted` if it touches sensitive fields.
- Reply drafts writer (search `from('reply_drafts').insert`) → `setReplyDraftEncrypted`.
- `src/lib/contacts.functions.ts` — every write that sets `notes`/`relationship_summary`/`phone`/`address_*` → `setContactEncryptedFields`. Other contact fields stay direct.

Reads stay on plaintext columns through Phase 2 — dual-write means readers still see correct data. Switching reads to `get_emails_decrypted` / `get_contact_decrypted` / `search_emails` happens in Phase 3 right before plaintext columns are dropped, after backfill fills `*_enc` for historical rows.



## Phase 3 — TODO: stop writing plaintext, then drop the columns

1. Audit: confirm no code path still writes to the plaintext columns (rg over `from('emails')`, `from('reply_drafts')`, `from('contacts')`, `from('folder_examples')` for `.insert` / `.update` of sensitive fields).
2. Cron-driven backfill: new `/api/public/cron/encryption-backfill` (CRON_SECRET-gated) that batches old rows through `update_email_encrypted` / `set_contact_encrypted_fields` / equivalents to fill `*_enc` for legacy data, and writes the search index for old emails.
3. Migration drops the plaintext columns: `subject`, `snippet`, `body_text`, `body_html`, `from_name`, `to_addrs`, `cc`, `ai_summary`, `classification_reason`, `reply_drafts.draft_text`, `contacts.{notes,relationship_summary,address_line1,address_line2,phone}`, `folder_examples.{subject,snippet}`.
4. Tighten `src/routes/privacy.tsx` from "disk-level encryption + column-level on OAuth tokens" to "column-level AEAD on bodies, subjects, summaries, drafts, and contact notes".

## Out of scope

- pgsodium / managed key vault — not available on the current plan; pgcrypto + `EMAIL_ENC_KEY` is the established pattern.
- Client-side / end-to-end encryption — incompatible with server-side AI classification.
- Encrypting `from_addr`, gmail/thread/message ids, raw labels — needed plaintext for filter joins, dedupe, Gmail API calls, and contact derivation.
- Automatic key rotation — `key_version` column is in place; rotate job is a separate plan.
