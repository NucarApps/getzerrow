# Phase 3 — Drop plaintext, batch-decrypt for list views

## Scope

Drop 11 plaintext columns: `emails.body_text/body_html/ai_summary/classification_reason`, `reply_drafts.draft_text`, `contacts.notes/relationship_summary/address_line1/address_line2/phone`.

To keep list-view rendering, add **batch decrypt RPCs** that the inbox and contacts lists call for the rows currently visible, returning only the small fields needed (no body_text/body_html).

## Step 1 — New batch-decrypt RPCs (Migration A)

```sql
-- Returns just the small derived fields per email id.
CREATE FUNCTION public.get_emails_list_fields_decrypted(p_ids uuid[], p_key text)
  RETURNS TABLE(id uuid, ai_summary text, classification_reason text)
  LANGUAGE sql STABLE SECURITY DEFINER ...;

-- Same for contacts.
CREATE FUNCTION public.get_contacts_list_fields_decrypted(p_ids uuid[], p_key text)
  RETURNS TABLE(id uuid, relationship_summary text)
  LANGUAGE sql STABLE SECURITY DEFINER ...;
```

Both filter rows by `auth.uid()` via the calling context to prevent leakage even with arbitrary ids.

Add a `claim_forward_retries(p_limit, p_key)` overload that returns decrypted `body_text` so forward-retry continues working.

Wrap them in `encrypted-reader.ts`: `getEmailListFields(ids)`, `getContactListFields(ids)`, `claimForwardRetries(limit)`.

## Step 2 — Refactor remaining read sites

| File | Current | New |
|---|---|---|
| `src/routes/_authenticated/inbox.tsx` | `LIST_COLUMNS` includes `ai_summary, classification_reason` | Drop both from `LIST_COLUMNS`. After list fetch + on realtime update, call `getEmailListFields` for visible ids and merge into row state. |
| `src/routes/_authenticated/contacts.index.tsx` (list) | Selects `relationship_summary` plaintext | Drop from select, call `getContactListFields` for visible ids, merge. |
| `src/components/contacts/ContactDetailView.tsx` | Selects plaintext PII | Switch to `getContactDecrypted` via existing `getContact` serverFn (or add one). |
| `src/lib/contacts.functions.ts` line 154 | `.select(..., relationship_summary)` | Drop column from select, fetch via `getContactDecrypted` per row only when needed. |
| `src/lib/contacts.functions.ts` line 916 | `.select(..., address_*, phone)` | Same pattern. |
| `src/lib/sync/forward-retry.ts` | calls `claim_forward_retries` returning `body_text` plaintext | Call new key-aware overload. |
| `src/lib/move-email.server.ts` line 56 | direct `.update({ classification_reason })` | Route through `updateEmailEncrypted`. |
| `src/lib/sync/reconcile.ts` line 129 | passes body_text/body_html into encrypted-writer | Already correct, no change. |

## Step 3 — Update existing RPCs (same Migration A)

- `upsert_email_encrypted`, `insert_email_encrypted`, `update_email_encrypted`: stop writing plaintext into `body_text/body_html/ai_summary/classification_reason`; still write `*_enc`.
- `set_reply_draft_encrypted`: stop writing `draft_text`.
- `set_contact_encrypted_fields`: stop writing `notes/relationship_summary/address_line1/address_line2/phone` plaintext.
- `get_emails_decrypted`, `get_contact_decrypted`, `get_reply_draft_decrypted`: drop `COALESCE(decrypt, plaintext)` — just `private.decrypt_text(...)`.
- `claim_forward_retries`: replace with key-aware version that decrypts body_text.
- `backfill_*_encryption`: drop (no longer needed — no plaintext source to backfill from).

## Step 4 — Drop columns (Migration B)

```sql
ALTER TABLE public.emails
  DROP COLUMN body_text, DROP COLUMN body_html,
  DROP COLUMN ai_summary, DROP COLUMN classification_reason;
ALTER TABLE public.reply_drafts DROP COLUMN draft_text;
ALTER TABLE public.contacts
  DROP COLUMN notes, DROP COLUMN relationship_summary,
  DROP COLUMN address_line1, DROP COLUMN address_line2,
  DROP COLUMN phone;
```

Then regenerate types (auto).

## Order of execution

1. Migration A (new + updated RPCs, *before* code changes — so the new RPCs exist and the old RPCs still write plaintext as a safety net).
2. Refactor all code call sites (Steps 2). After this turn the app reads exclusively via encrypted helpers and writes only via `*_encrypted` RPCs.
3. Migration B (drop columns + drop COALESCE in read RPCs + drop backfills).
4. Verify: inbox loads, list summaries appear after a brief lag, reanalyze works, forward retry works, contact drawer loads, reply draft round-trip works.

## Risk

- Drop is destructive. All 4 buckets confirmed fully encrypted (Phase 3a verification). Rollback = restore from backup.
- Brief flicker on list views as summaries arrive after the initial fetch (acceptable tradeoff per Option 2 choice).
- `email_search_index` keeps its tsvector built from plaintext at write time — substring search via `search_emails` continues working unchanged.

## Estimated turns

3-4 turns:
1. Migration A.
2. Refactor calls sites (1-2 turns).
3. Migration B + verify.
