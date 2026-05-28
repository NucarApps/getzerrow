# Phase 3b — Option B: Drop high-sensitivity plaintext

Goal: drop the columns that hold body and PII content; keep subject/snippet/from_name/to_addrs/cc plaintext so the inbox UI and substring filtering keep working.

## Columns dropped

| Table | Columns dropped | Kept plaintext |
|---|---|---|
| `emails` | `body_text`, `body_html`, `ai_summary`, `classification_reason` | `subject`, `snippet`, `from_name`, `from_addr`, `to_addrs`, `cc` |
| `reply_drafts` | `draft_text` | — |
| `contacts` | `notes`, `relationship_summary`, `address_line1`, `address_line2`, `phone` | `email`, `name`, `title`, `company`, address city/region/postal/country |
| `folder_examples` | (none — already only `*_enc`) | `subject`, `snippet` already kept plaintext + enc |

## Step 1 — Helper layer (new)

Add `src/lib/sync/encrypted-reader.ts`:
- `getEmailsDecrypted(ids: string[])` → wraps `get_emails_decrypted` RPC; returns body_text/body_html/ai_summary/classification_reason via decrypt.
- `getContactDecrypted(id)` → wraps `get_contact_decrypted` RPC.
- `getReplyDraftDecrypted(emailId)` → wraps `get_reply_draft_decrypted` RPC.

Pattern at every refactored call site:
1. Select the rows you need (id + non-sensitive columns) with normal `.select(...)`.
2. If you also need `body_text`/`body_html`/`ai_summary`/`classification_reason`, call `getEmailsDecrypted(ids)` and merge.
3. Never select dropped columns directly.

## Step 2 — Refactor read sites

### Sync pipeline (server, hot path)
- `src/lib/sync/process-message.ts` — uses parsed `body_text` from Gmail, not DB read — no change.
- `src/lib/sync/classify.ts` — same; receives parsed payload, no DB read of body.
- `src/lib/sync/folder-learn.ts` — reads `body_text` of past emails for learning → switch to `getEmailsDecrypted`.
- `src/lib/sync/reconcile.ts` — verify what it reads; refactor if needed.
- `src/lib/sync/forward-retry.ts` — uses `claim_forward_retries` RPC (already selects body_text from emails table). Update RPC to read from decrypted RPC OR keep body_text plaintext temporarily — TBD.

### App server functions
- `src/lib/gmail.functions.ts` (8 sites with body_text/body_html/ai_summary/classification_reason):
  - Lines 49, 700, 760, 1260, 2758: scan/repeat-classify flows that need body for AI → `getEmailsDecrypted`.
  - Writes of `classification_reason`/`ai_summary` → already go via `updateEmailEncrypted` for some; audit the direct `.update({ classification_reason: … })` calls and route through `updateEmailEncrypted` (which writes `*_enc` and stops writing the dropped plaintext col).
- `src/lib/contacts.functions.ts`:
  - 3 places read sender's emails (`subject,body_text,snippet,from_*`) for AI summarization/extraction → `getEmailsDecrypted` for the body_text column.
- `src/lib/cards.server.ts`, `src/lib/summaries.server.ts`, `src/lib/ai.server.ts`, `src/lib/sync.server.ts`, `src/lib/move-email.server.ts`, `src/lib/gmail.server.ts` — audit & refactor each remaining body/ai_summary/classification_reason read.

### UI (browser)
- `src/routes/_authenticated/inbox.tsx` — confirm it doesn't select dropped columns. (Inbox list uses subject/snippet which stay.)
- `src/routes/_authenticated/contacts.index.tsx`, `contacts.scan.tsx`, `src/components/contacts/ContactDetailView.tsx` — switch `relationship_summary`/`notes`/`phone`/`address_*` reads to `get_contact_decrypted` RPC via a server fn wrapper.
- `src/components/folders/FolderEditor.tsx` — review for any dropped-column reads.

## Step 3 — Update writer RPCs

Migration updates the writer functions to stop writing plaintext into dropped columns (since the columns won't exist):

- `upsert_email_encrypted`, `insert_email_encrypted`, `update_email_encrypted` — remove `body_text`, `body_html`, `ai_summary`, `classification_reason` from the INSERT/UPDATE column lists.
- `set_reply_draft_encrypted` — remove `draft_text`.
- `set_contact_encrypted_fields` — remove `notes`, `relationship_summary`, `address_line1`, `address_line2`, `phone` plaintext writes.
- `get_emails_decrypted` / `get_contact_decrypted` / `get_reply_draft_decrypted` — remove the `COALESCE(decrypt, plaintext)` fallback (just `decrypt_text(...)`).
- `claim_forward_retries` — replace `e.body_text` with `private.decrypt_text(e.body_text_enc, key)`. Needs key parameter added.
- `backfill_emails_encryption`, `backfill_reply_drafts_encryption`, `backfill_contacts_encryption` — no longer needed; can be dropped or left as no-ops.

## Step 4 — Drop columns migration

Single migration at the end:
```sql
ALTER TABLE public.emails
  DROP COLUMN body_text,
  DROP COLUMN body_html,
  DROP COLUMN ai_summary,
  DROP COLUMN classification_reason;

ALTER TABLE public.reply_drafts DROP COLUMN draft_text;

ALTER TABLE public.contacts
  DROP COLUMN notes,
  DROP COLUMN relationship_summary,
  DROP COLUMN address_line1,
  DROP COLUMN address_line2,
  DROP COLUMN phone;
```

## Order of execution

1. Add `encrypted-reader.ts` helper.
2. Migration A: update read RPCs to drop `COALESCE` fallback + add key param to `claim_forward_retries` + update writer RPCs to stop writing dropped columns.
3. Refactor code call sites (all 20 files).
4. Migration B: drop the columns.
5. Verify: realtime inbox loads, classify still works, contacts page reads, reply draft round-trip.

## Risk / rollback

- Migration B is destructive (column drops). Once shipped, rollback means restoring from backup. Realtime ingestion will continue producing only `*_enc` data.
- All encryption is real today (verified Phase 3a: 0 rows unencrypted in any of the 4 buckets). Dropping the plaintext mirrors loses no information.
- `email_search_index` keeps its tsvector — substring search via `search_emails` RPC continues working.

## Estimated turns

~6-10 turns: 1 helper file, 1 migration for RPCs, 4-6 turns to refactor the 20 call sites, 1 final drop-column migration, 1 verification.
