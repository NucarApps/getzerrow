// Pure helper for the Gmail history walk.
//
// THE BUG THIS FIXES
//   Gmail's users.history.list returns, for EVERY history record, a
//   generic `messages` array listing all messages the record touched —
//   in addition to the typed arrays (messagesAdded / messagesDeleted /
//   labelsAdded / labelsRemoved). The old walk did:
//
//     const added = h.messagesAdded?.map(x => x.message) ?? h.messages ?? [];
//
//   For a label-only record (user archived a message in Gmail →
//   labelsRemoved: ["INBOX"]), `messagesAdded` is undefined, so the
//   fallback dumped the affected message ids into `seenAdded`. Later the
//   walk skips label ops whose message is in `seenAdded` (those rows are
//   assumed to be still-queued new mail) — so the archive signal was
//   dropped, and the message was pointlessly re-enqueued as a "new mail"
//   job which no-ops for healthy existing rows. Net effect: archiving in
//   Gmail never reached Zerrow until a reconcile sweep happened to visit
//   that row.
//
// CORRECT SEMANTICS
//   - `messagesAdded` is the ONLY authoritative "new mail" signal.
//   - `h.messages` is used as a defensive fallback ONLY when the record
//     carries no typed arrays at all (unexpected shape — better to
//     ingest than to drop).
export type GmailHistoryRecord = {
  messages?: Array<{ id: string; threadId?: string }>;
  messagesAdded?: Array<{ message: { id: string; threadId?: string; labelIds?: string[] } }>;
  messagesDeleted?: Array<{ message: { id: string; threadId?: string; labelIds?: string[] } }>;
  labelsAdded?: Array<{
    message: { id: string; threadId?: string; labelIds?: string[] };
    labelIds: string[];
  }>;
  labelsRemoved?: Array<{
    message: { id: string; threadId?: string; labelIds?: string[] };
    labelIds: string[];
  }>;
};

/** Messages genuinely ADDED by this history record. Label-only and
 * delete-only records return [] — their `messages` list is just "what
 * the record touched", not new mail. */
export function collectAddedMessages(h: GmailHistoryRecord): Array<{ id: string }> {
  if (h.messagesAdded) return h.messagesAdded.map((x) => x.message);
  const hasTypedEvents =
    (h.labelsAdded?.length ?? 0) > 0 ||
    (h.labelsRemoved?.length ?? 0) > 0 ||
    (h.messagesDeleted?.length ?? 0) > 0;
  if (hasTypedEvents) return [];
  // Unexpected record shape (no typed arrays at all): fall back to the
  // generic list so we never silently drop real mail.
  return h.messages ?? [];
}
