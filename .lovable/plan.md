
## Goal

When `enrichContact` finds no local emails for a contact's address, query Gmail directly with `from:<email>` (and optionally `to:<email>` for the relationship summary), fetch a handful of messages, and feed them into the existing extraction + relationship-summary prompts. This lets brand-new contacts get enriched without waiting for the sync pipeline to backfill them.

## Where the change lives

`src/lib/contacts.functions.ts` → `enrichContact` server function only. No schema changes, no UI changes, no new public endpoints.

## Behavior

1. Run the existing local query against `emails_decrypted` (unchanged).
2. If it returns 0 rows, look up the user's Gmail accounts (`gmail_accounts` filtered by `user_id`). For each account (stop at first that returns results):
   - Call `listMessages(accountId, { q: \`from:${email}\`, maxResults: 20 })`.
   - For each id, `getMessage` + `parseMessage` (existing helpers in `src/lib/gmail.server.ts`).
   - Map the parsed payloads into the same shape the local query produces (`subject`, `body_text`, `snippet`, `from_name`) so the rest of the scoring/picking pipeline is unchanged.
3. Same fallback for the relationship-summary block: if the local `or(from_addr.eq, to_addrs.ilike)` query is empty, run a second Gmail search with `q: \`from:${email} OR to:${email}\`` and map results into the convo shape (need `from_addr`, `to_addrs`, `received_at` too — all available from `parseMessage`).
4. Cap Gmail fetches: max 20 messages per fallback, fetch sequentially with the existing `gmailFetch` (already has timeouts + retry classification). If Gmail returns `insufficientPermissions`/quota errors, swallow and proceed as if empty (current "no sample" path already handles this gracefully).
5. Do not persist these fetched messages into the `emails` table — this is read-only enrichment. The regular sync/reconcile pipeline owns ingestion.

## Technical notes

- Reuse `listMessages`, `getMessage`, `parseMessage` from `src/lib/gmail.server.ts`; no new Gmail helpers needed.
- Pick the Gmail account by `user_id = auth uid`, ordered by `created_at` ascending; first one usually suffices.
- Wrap the Gmail fallback in `try/catch` so any `GmailApiError` (token expiry, 429) degrades to the existing "no sample" early-return path rather than failing the whole enrichment.
- Keep the function under `requireSupabaseAuth` (already is). No new RLS or secrets needed.

## Out of scope

- Storing fetched messages in `emails`.
- Changing the contacts UI or the `getContact` loader.
- Adding a manual "refetch from Gmail" button (can be a follow-up).
