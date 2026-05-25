## Goal

Fix the production outage where deployed code references DB columns/RPCs that don't exist yet. The 8 migration files already exist in `supabase/migrations/` but have NOT been applied to the database (verified: `gmail_accounts.reconcile_cursor` missing, none of the new RPCs exist).

## Plan

Apply the 8 migrations in order via the migration tool. Because the tool runs one migration per call and each call requires user approval, I'll submit them sequentially:

1. `20260525120000_email_sync_improvements.sql` — new columns on `gmail_accounts`, `emails`, `message_jobs`, `pubsub_events`
2. `20260525150000_email_sync_review_fixes.sql` — review fixups
3. `20260525150001_claim_message_jobs_publish.sql` — update `claim_message_jobs` RPC to return `published_at_ms`
4. `20260525170000_sync_rpcs.sql` — `bump_history_id_if_greater`, `claim_forward_retries`, etc.
5. `20260525170001_indexes_for_new_queries.sql` — 9 new indexes
6. `20260525180000_sync_latency_stats.sql` — `get_sync_latency_stats` RPC
7. `20260525190000_realtime_drop_body_columns.sql` — `ALTER PUBLICATION supabase_realtime SET TABLE emails (...)` dropping `body_text`/`body_html`
8. `20260525200000_retention_cleanup.sql` — `cleanup_old_pubsub_events`, `cleanup_old_dlq_jobs`

## Verification after each / at the end

- Columns present on `gmail_accounts`, `emails`, `message_jobs`, `pubsub_events`
- The 5 new RPCs exist and are `service_role`-only
- Indexes exist
- `supabase_realtime` publication no longer broadcasts `body_text`/`body_html`
- Run `supabase--linter` after migrations and address any new warnings

## Notes

- No application code changes — code is already aligned with these migrations.
- No data migration needed; all changes are additive except the realtime publication column list.
