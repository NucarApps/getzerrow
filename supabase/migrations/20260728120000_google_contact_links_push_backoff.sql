-- Body-push failure budget for Google Contacts.
--
-- Before this, a contact whose People API write kept failing (the live case:
-- 429 RESOURCE_EXHAUSTED / "FBS quota limit exceeded") stayed dirty forever —
-- `last_synced_at` only advances on success, so every sync run re-attempted the
-- same doomed write and burned account-wide contact-write quota that healthy
-- contacts needed. The photo lane already had `photo_push_attempts`; the body
-- lane had nothing.
--
-- Backoff rather than a hard give-up: the quota does reset, so the contact must
-- eventually come back. See PUSH_BACKOFF_BASE_MS / PUSH_BACKOFF_MAX_MS in
-- src/lib/google-contacts/dirty.ts (5 min doubling to a 6 h ceiling).
ALTER TABLE public.google_contact_links
  ADD COLUMN IF NOT EXISTS push_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS push_backoff_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_push_error text,
  ADD COLUMN IF NOT EXISTS last_push_error_at timestamptz;

-- Selection reads "which links are cooling off" on every push run.
CREATE INDEX IF NOT EXISTS google_contact_links_push_backoff_idx
  ON public.google_contact_links (gmail_account_id, push_backoff_until)
  WHERE push_backoff_until IS NOT NULL;

INSERT INTO public.pubsub_events (event_type, details)
VALUES ('migration', 'google_contact_links: push_attempts/push_backoff_until added (429 retry storm fix)');
