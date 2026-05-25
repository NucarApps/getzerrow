-- Index audit follow-up. Every query path added by the email-sync work
-- needs at minimum a sargable leading column; without these the new
-- features will work but degrade as the tables grow.
--
-- Existing pubsub_events_received_at_idx (received_at DESC) is fine for
-- "give me the last N events overall" but ALL the new diagnostic /
-- silence-detection queries filter by event_type or email_address first,
-- then order by received_at. PostgreSQL won't use the single-column index
-- well when the first equality predicate is event_type.

-- ─── pubsub_events ───────────────────────────────────────────────────────

-- Used by:
--   gmail-poll.ts — "find recent watch_rearm_auto events to enforce
--     re-arm cooldown" (event_type = ? AND received_at >= ?)
--   gmail-reconcile.ts — "find accounts with recent push errors"
--     (received_at >= ? AND error IS NOT NULL)
--   PubsubActivity / listPubsubEvents — "last push", "last watch_renew",
--     "events of type X" (event_type = ? ORDER BY received_at DESC)
-- A composite (event_type, received_at DESC) is the canonical shape.
CREATE INDEX IF NOT EXISTS pubsub_events_type_received_idx
  ON public.pubsub_events (event_type, received_at DESC);

-- Used by listPubsubEvents per-user feed: filters by
-- email_address IN (...). Single-column index on email_address means
-- Postgres can satisfy the IN with a bitmap-or scan, then sort by
-- received_at from the unsorted set — still better than full seqscan as
-- the table grows.
CREATE INDEX IF NOT EXISTS pubsub_events_email_received_idx
  ON public.pubsub_events (email_address, received_at DESC)
  WHERE email_address IS NOT NULL;

-- Used by gmail-webhook.ts dedup: "is there a `push` row with this
-- message_id in the last 60s?". Without an index this does a full table
-- scan on every Pub/Sub redelivery — expensive at scale and worse, slow
-- enough that Pub/Sub may re-redeliver before dedup completes.
CREATE INDEX IF NOT EXISTS pubsub_events_message_id_idx
  ON public.pubsub_events (message_id)
  WHERE message_id IS NOT NULL;

-- ─── emails ──────────────────────────────────────────────────────────────

-- Used by:
--   reconcileLocalInbox head — (gmail_account_id, is_archived=false)
--     ORDER BY received_at DESC LIMIT 60
--   reconcileLocalInbox tail — same + AND received_at < cursor
--   reconcileLocalInbox second pass — (gmail_account_id, is_archived=true)
--     ORDER BY received_at DESC LIMIT 200
-- Composite covers all three. is_archived has low cardinality (2 values)
-- but lives as the middle key so Postgres can sub-range-scan within
-- (account, archived) groups.
CREATE INDEX IF NOT EXISTS emails_account_archived_received_idx
  ON public.emails (gmail_account_id, is_archived, received_at DESC);

-- ─── message_jobs ────────────────────────────────────────────────────────

-- Used by tickBackfillJob processing-phase: "how many non-DLQ jobs are
-- still pending for this account?" The existing claim/picker indexes are
-- ordered by (priority, next_run_at) — wrong leading column for an
-- account-scoped count.
CREATE INDEX IF NOT EXISTS message_jobs_account_status_idx
  ON public.message_jobs (gmail_account_id, status)
  WHERE status <> 'dlq';

-- ─── gmail_accounts ──────────────────────────────────────────────────────

-- Renew-watches cron filters by watch_expiration: very small tables don't
-- need this, but adding it now avoids a per-cron seqscan once mailboxes
-- per deployment grow into the thousands.
CREATE INDEX IF NOT EXISTS gmail_accounts_watch_expiration_idx
  ON public.gmail_accounts (watch_expiration);
