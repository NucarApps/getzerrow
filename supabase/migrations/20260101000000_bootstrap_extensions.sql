-- Bootstrap extensions used by later migrations.
--
-- Timestamped before every other migration on purpose: the first
-- `cron.schedule(...)` call (20260520174513) predates the migration that
-- creates pg_cron (20260521190714), so a fresh `supabase db reset` fails
-- with `schema "cron" does not exist` and the DB-backed integration suite
-- never runs in CI. Every statement is idempotent, so applying this on a
-- database that already has the extensions is a no-op.
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto with schema extensions;
