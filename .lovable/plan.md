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

## Phase 2 — TODO: route ingest writes through the new RPCs

Goal: every new row written goes through the encrypted RPC. Plaintext columns are also written for now (dual-write) so existing reads still work.

Touch points (all server-side, use `supabaseAdmin.rpc(...)`):
- `src/lib/sync/process-message.ts` — `supabaseAdmin.from('emails').insert(...)` → `rpc('insert_email_encrypted', { ..., p_key: process.env.EMAIL_ENC_KEY })`. Same for the `.update(...)` calls that touch subject/snippet/body/ai_summary/classification_reason → `rpc('update_email_encrypted', ...)`. Calls that only mutate flags (`is_read`, `is_archived`, `folder_id`, etc.) stay on direct `.update()`.
- `src/lib/sync/classify.ts` and `src/lib/sync/folder-learn.ts` — `ai_summary` / `classification_reason` updates → `update_email_encrypted`. New folder examples → `insert_folder_example_encrypted`.
- `src/lib/sync/forward-retry.ts` — `claim_forward_retries` RPC needs a sibling that decrypts `body_text`/`subject`/`from_name` for the forward composer (mirror the OAuth-token decrypt pattern). Stop reading the plaintext columns there.
- `src/lib/sync/reconcile.ts` — same as process-message.
- `src/lib/ai-assistant.functions.ts`, `src/lib/summaries.server.ts`, `src/lib/reports.functions.ts`, `src/lib/move-email.server.ts` — anywhere these read subject/snippet/body/from_name from `emails`, switch to `get_emails_decrypted`.
- `src/lib/contacts.functions.ts` — contact writes/reads of phone/notes/relationship_summary/address_* → `set_contact_encrypted_fields` / `get_contact_decrypted`.
- Reply drafts (writer + reader) → `set_reply_draft_encrypted` / `get_reply_draft_decrypted`.

Inbox UI (`src/routes/_authenticated/inbox.tsx`):
- The list query currently selects subject/snippet/from_name directly from `emails`. Move list rendering through a new `listInboxEmails` server fn that calls `get_emails_decrypted` for the visible page. Detail view already fetches by id — same fn, single id array.
- Realtime: keep the existing channel as a "row changed" signal; on event, the UI calls the list/detail server fn for the affected id instead of reading the row from the realtime payload.
- Search box: new `searchInbox` server fn → `search_emails`.

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
