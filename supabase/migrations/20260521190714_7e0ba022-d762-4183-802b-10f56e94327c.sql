-- Enable scheduling + outbound HTTP from Postgres
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Helper that reads the cron shared secret from Supabase Vault.
-- Runs as the function owner so pg_cron (which executes as postgres) can read it
-- without needing direct access to the vault schema.
create or replace function private.cron_secret()
returns text
language sql
stable
security definer
set search_path = vault, public
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'cron_secret'
  limit 1;
$$;

-- Lock the helper down: only postgres (and pg_cron) need to call it.
revoke all on function private.cron_secret() from public;
revoke all on function private.cron_secret() from anon, authenticated;