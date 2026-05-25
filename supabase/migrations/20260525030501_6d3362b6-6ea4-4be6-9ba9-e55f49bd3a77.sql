CREATE INDEX IF NOT EXISTS pubsub_events_type_received_idx ON public.pubsub_events (event_type, received_at DESC);
CREATE INDEX IF NOT EXISTS pubsub_events_email_received_idx ON public.pubsub_events (email_address, received_at DESC) WHERE email_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS pubsub_events_message_id_idx ON public.pubsub_events (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS emails_account_archived_received_idx ON public.emails (gmail_account_id, is_archived, received_at DESC);
CREATE INDEX IF NOT EXISTS message_jobs_account_status_idx ON public.message_jobs (gmail_account_id, status) WHERE status <> 'dlq';
CREATE INDEX IF NOT EXISTS gmail_accounts_watch_expiration_idx ON public.gmail_accounts (watch_expiration);