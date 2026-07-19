// Columns selected for any email list view. Excludes body_text + body_html
// (often multi-MB) — those are fetched on-demand when the user actually
// opens an email. Keeps both the initial fetch AND every realtime UPDATE
// payload small. raw_labels is included because the "no_rules" filter reads
// it. snoozed_until is included so local search results can apply the same
// visibility filter as normal lists. forward_* columns are operator-facing,
// not rendered in the inbox. Shared between the inbox UI and the searchInbox
// server fn so the two can never drift.
export const EMAIL_LIST_COLUMNS =
  "id,from_addr,received_at,is_read,is_archived,folder_id,ai_confidence,thread_id,classified_by,matched_filter_ids,matched_folder_ids,has_attachment,processed_at,raw_labels,snoozed_until,gmail_message_id,surfaced_to_inbox";
