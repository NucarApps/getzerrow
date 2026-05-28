# Fix empty inbox / "All mail" after Phase 3 encryption migration

## Root cause

Phase 3 dropped the plaintext columns `subject`, `snippet`, `from_name`, `to_addrs`, `cc` from `public.emails` (only `*_enc` bytea columns remain). The inbox query in `src/routes/_authenticated/inbox.tsx` still selects them via:

```
const LIST_COLUMNS = "id,from_addr,from_name,subject,snippet,...,to_addrs,...";
```

PostgREST rejects the request with a column-not-found error, the catch falls through to `data ?? []`, and every folder (All mail, INBOX, folder views, search) renders as empty. The user noticed it on "All mail" but every list is affected.

`getEmailListFields` already round-trips through a SECURITY DEFINER RPC to hydrate `ai_summary` + `classification_reason`. We extend that same RPC to also return the four missing list-row fields and drop them from the client-side select.

## Steps

### 1. Migration — extend the list-fields RPC

Replace `public.get_emails_list_fields_decrypted` so it also decrypts `subject`, `snippet`, `from_name`, `to_addrs`, `cc`:

```sql
CREATE OR REPLACE FUNCTION public.get_emails_list_fields_decrypted(p_ids uuid[], p_key text)
RETURNS TABLE (
  id uuid,
  ai_summary text,
  classification_reason text,
  subject text,
  snippet text,
  from_name text,
  to_addrs text,
  cc text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','private','extensions'
AS $$
  SELECT
    e.id,
    private.decrypt_text(e.ai_summary_enc, p_key),
    private.decrypt_text(e.classification_reason_enc, p_key),
    private.decrypt_text(e.subject_enc, p_key),
    private.decrypt_text(e.snippet_enc, p_key),
    private.decrypt_text(e.from_name_enc, p_key),
    private.decrypt_text(e.to_addrs_enc, p_key),
    private.decrypt_text(e.cc_enc, p_key)
  FROM public.emails e
  WHERE e.id = ANY(p_ids);
$$;
```

(No new grants needed; existing EXECUTE grants on the function remain.)

### 2. Update reader types — `src/lib/sync/encrypted-reader.ts`

Extend `EmailListFields` with the five new nullable string fields. `getEmailListFieldsDecrypted` already passes the rows through, so no logic change.

### 3. Update the server fn that exposes it — `src/lib/gmail.functions.ts`

Find the `getEmailListFields` createServerFn and add `subject`, `snippet`, `from_name`, `to_addrs`, `cc` to the returned shape (alongside `ai_summary` / `classification_reason`).

### 4. Update the inbox query — `src/routes/_authenticated/inbox.tsx`

- Remove `subject,snippet,from_name,to_addrs` from `LIST_COLUMNS` (keep `from_addr` — still plaintext). The constant becomes:
  `"id,from_addr,received_at,is_read,is_archived,folder_id,ai_confidence,thread_id,classified_by,matched_filter_ids,matched_folder_ids,has_attachment,processed_at,raw_labels,snoozed_until,gmail_message_id"`.
- In the operator-search branch, drop the server-side `ilike` on `subject`, `snippet`, `from_name`, `to_addrs` (the columns are gone). Keep the server-side `from_addr` filter; defer subject / snippet / to_addrs matching to the existing client-side scorer that runs over hydrated rows.
- Extend the `listFieldsQ` merge (around line 617-`pageRows`) so the page row gets `subject`, `snippet`, `from_name`, `to_addrs`, `cc` from the hydrated map in addition to `ai_summary` / `classification_reason`.
- `gmailHitRowsQ` uses the same `LIST_COLUMNS` — automatically fixed once the constant changes; its ids will flow into `visibleIds` and hydrate the same way.

### 5. Realtime — no change required

`use-email-realtime.ts` merges raw INSERT/UPDATE payloads into the cached list. Those payloads now lack plaintext, but because `listFieldsQ.queryKey` is derived from `visibleIds`, a new id triggers a new hydration fetch automatically. Existing UPDATE events for `is_read` / `folder_id` / `raw_labels` carry no plaintext changes, so the in-place merge stays correct.

## Files touched

- new migration: `supabase/migrations/<timestamp>_extend_list_fields_rpc.sql`
- `src/lib/sync/encrypted-reader.ts` — extend `EmailListFields` type
- `src/lib/gmail.functions.ts` — extend `getEmailListFields` return shape
- `src/routes/_authenticated/inbox.tsx` — trim `LIST_COLUMNS`, drop server-side ilike on dropped columns, merge new fields into `pageRows`

## Verification

- Run `bunx tsc --noEmit` (must remain 0 errors).
- In the preview: open All mail, INBOX, a user folder, "no rules", and a search query — each should render rows with subject/snippet/from name populated.
- Confirm a newly arrived email (realtime INSERT) shows its subject within ~1 round-trip of the hydration query.
