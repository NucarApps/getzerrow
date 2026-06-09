## Production outage hotfix plan

### Goal
Restore sync, re-arm, and reclassify on `claude/email-sync-improvements-xVpbj` without applying the 11 stale migrations to the shared production database.

### Key decision
Do **not** apply the listed migrations to the shared production backend. The live database already contains the needed schema/RPC concepts, but under the current `EMAIL_ENC_KEY` / pgp_sym `_enc` design. The branch expects older pgsodium-style names/signatures, which is why it sees “Could not find the function”.

### What I will change
1. **Find branch calls to stale RPC signatures**
   - Search server code for:
     - `get_gmail_oauth_tokens` without `p_key`
     - `set_gmail_oauth_tokens` without `p_key`
     - `upsert_gmail_oauth_account` without `p_key`
     - `claim_forward_retries` instead of the live `claim_forward_retries_v2`
     - direct references to `*_encrypted` columns or pgsodium assumptions

2. **Align OAuth token access to production**
   - Ensure all token reads/writes call the existing live RPCs with `EMAIL_ENC_KEY`:
     - `get_gmail_oauth_tokens(p_account_id, p_key)`
     - `set_gmail_oauth_tokens(p_account_id, p_access_token, p_refresh_token, p_token_expires_at, p_key)`
     - `upsert_gmail_oauth_account(p_user_id, p_email_address, p_access_token, p_refresh_token, p_token_expires_at, p_key)`
   - Keep `EMAIL_ENC_KEY` read only on the server.

3. **Align forward retry claim path**
   - Replace stale `claim_forward_retries(p_limit)` usage with live `claim_forward_retries_v2(p_limit, p_key)`.
   - Make sure downstream code uses the decrypted fields returned by that RPC.

4. **Align encrypted email body reads/writes**
   - Remove any code expecting `body_text_encrypted` / `body_html_encrypted` or the pgsodium view shape.
   - Use existing live helper RPCs/functions that decrypt through `EMAIL_ENC_KEY`, such as the current `get_emails_decrypted`, `get_emails_list_fields_decrypted`, `insert_email_encrypted`, and `update_email_encrypted` paths.

5. **Preserve already-valid schema/RPC usage**
   - Keep calls to live-compatible objects already present:
     - `claim_message_jobs(...): published_at_ms`
     - `bump_history_id_if_greater`
     - `get_sync_latency_stats`
     - `cleanup_old_pubsub_events`
     - `cleanup_old_dlq_jobs`
     - `list_decryption_audit`

6. **Validate the outage path**
   - Run targeted searches/tests or invoke relevant code paths where possible.
   - Confirm no remaining references to the stale pgsodium migration names/signatures.
   - Confirm the code uses the live production RPC signatures.

### What I will not do
- I will not apply the 11 migrations to the shared production database.
- I will not introduce pgsodium keys or `_encrypted` columns.
- I will not change the production encryption standard away from `EMAIL_ENC_KEY` / pgp_sym `_enc`.
- I will not touch plaintext OAuth token storage.

### Expected result
The branch will stop calling missing/stale RPC signatures and will operate against the current production backend schema, restoring sync/re-arm/reclassify without risking the live database.