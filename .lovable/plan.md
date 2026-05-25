## Problem

Production deploys reference DB objects that aren't in the database yet:
- `public.emails_decrypted` view
- `private.get_gmail_oauth_tokens` / `private.upsert_gmail_oauth_account` RPCs
- `audit.decryption_log` table + `list_decryption_audit` RPC

Result: manual sync + reclassify 500 on every call. The earlier 8 migrations from the previous prompt are already on disk and applied; verified `to_regclass('audit.decryption_log')` and `emails_decrypted` both return NULL, confirming the encryption layer is missing.

## Migrations to apply (strict order)

Order matters — `230000` redefines the decrypt helpers + view that `220000` creates.

1. **`20260525210000_encrypt_oauth_tokens.sql`** *(on disk)*
   - Provisions pgsodium key `oauth_tokens_v1`
   - Adds `gmail_accounts.access_token_encrypted` / `refresh_token_encrypted` bytea
   - Creates `private.encrypt_oauth_token` / `decrypt_oauth_token` helpers
   - Creates `public.get_gmail_oauth_tokens(p_account_id)`, `public.set_gmail_oauth_tokens(...)`, `public.upsert_gmail_oauth_account(...)` RPCs (service_role only)
   - Backfills encryption from existing plaintext tokens

2. **`20260525220000_encrypt_email_bodies.sql`** *(on disk)*
   - Provisions pgsodium key `email_bodies_v1`
   - Adds `emails.body_text_encrypted` / `body_html_encrypted` bytea
   - BEFORE INSERT/UPDATE trigger `emails_encrypt_body` zeros plaintext after encrypting
   - Creates `public.emails_decrypted` view (`security_invoker = true`)
   - Redefines `claim_forward_retries` to decrypt body_text on the fly
   - Backfills existing rows through the trigger

3. **`20260525230000_decryption_audit_log.sql`** *(needs to be authored — not on disk; the branch copy is unavailable from the sandbox)*
   - `CREATE SCHEMA IF NOT EXISTS audit`
   - `audit.decryption_log` table: `id`, `occurred_at`, `caller` (role), `kind` (`'oauth'|'email_body'`), `row_id uuid NULL`, `success boolean`
   - `CREATE OR REPLACE` of `private.decrypt_oauth_token` and `private.decrypt_email_body` to `INSERT INTO audit.decryption_log` on each call (best-effort, swallow logging errors so a logging failure can't break decrypt)
   - `CREATE OR REPLACE VIEW public.emails_decrypted` re-emitted unchanged so it picks up the new decrypt helper definition
   - `public.list_decryption_audit(p_limit int default 100)` SECURITY DEFINER RPC returning recent rows, granted to `service_role` only
   - RLS enabled on `audit.decryption_log` with no policies (service_role bypasses)

## Execution

Each migration is applied via the `supabase--migration` tool, one call per file, in the order above (the tool requires user approval per call). I'll wait for confirmation between calls to avoid partial application. Migration #3 will be authored inline (content above) since the branch isn't fetchable here — if you have the exact branch SQL, paste it and I'll use that verbatim instead.

## Verification (run after all three apply)

```sql
SELECT viewname FROM pg_views
 WHERE schemaname='public' AND viewname='emails_decrypted';

SELECT proname FROM pg_proc
 WHERE proname IN ('get_gmail_oauth_tokens',
                   'upsert_gmail_oauth_account',
                   'list_decryption_audit');

SELECT to_regclass('audit.decryption_log');
```

All three should return rows / a non-null oid. I'll also run `supabase--linter` after the last migration and surface any new findings.

## Question before I start

The branch file `20260525230000_decryption_audit_log.sql` isn't in the sandbox checkout. Do you want me to:

(a) author migration #3 from the description above, or
(b) wait while you paste the exact SQL from the branch?

If (a), I'll proceed immediately after you approve this plan.
