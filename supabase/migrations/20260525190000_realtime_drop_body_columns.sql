-- Reduce realtime WebSocket traffic by dropping body_text + body_html from
-- the published columns.
--
-- BACKGROUND
--   ALTER TABLE emails REPLICA IDENTITY FULL was set up so postgres_changes
--   payloads include the entire row. That works for label/classification
--   updates but is wasteful for email bodies: every UPDATE (auto-archive,
--   auto-mark-read, re-classify, reconcile patch) ships the full body
--   over the user's WebSocket. A 5 MB HTML email × 3-4 UPDATEs per arrival
--   adds up fast on a busy mailbox.
--
-- TRADE-OFF
--   - The realtime payload's `new` object will no longer contain
--     body_text / body_html. The inbox list cache populates body from the
--     initial useQuery; new INSERT events arrive without body. Detail-view
--     code paired with this change in inbox.tsx fetches the full row
--     on-demand when the user opens an email (already the pattern for
--     search results).
--   - The COLUMN STILL EXISTS in the emails table and is still readable
--     via normal queries. Only the realtime channel skips it.
--
-- POSTGRES SEMANTICS
--   Removing a table from the publication and re-adding it with a column
--   list filters which columns appear in WAL changeset events. Existing
--   subscriptions reconnect transparently.

-- Drop and re-add to switch from "all columns" to a column list. We keep
-- every column the inbox list rendering uses; bodies + raw_labels (large
-- arrays) are excluded. raw_labels is still readable via the on-demand
-- selectedFullQ fetch.
ALTER PUBLICATION supabase_realtime DROP TABLE public.emails;

ALTER PUBLICATION supabase_realtime ADD TABLE public.emails (
  id,
  user_id,
  gmail_account_id,
  gmail_message_id,
  thread_id,
  from_addr,
  from_name,
  to_addrs,
  cc,
  list_id,
  in_reply_to,
  subject,
  snippet,
  received_at,
  is_read,
  is_archived,
  has_attachment,
  folder_id,
  classified_by,
  classification_reason,
  ai_summary,
  ai_confidence,
  matched_filter_ids,
  matched_folder_ids,
  -- raw_labels is small (string[]) and the inbox "no_rules" filter reads it.
  raw_labels,
  snoozed_until,
  forwarded_to,
  forwarded_at,
  processed_at,
  published_at_ms,
  created_at,
  updated_at
);
