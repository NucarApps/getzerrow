// Mailbox-wide read-state reconciliation against Gmail.
//
// The Pub/Sub history path is the real-time fast path for read changes, but
// it can miss events (read older mail in Gmail, folder-filed mail, dropped
// pushes). Per-message label fetches in the reconcile cron only cover a small
// window each tick. This helper instead asks Gmail for the *set* of currently
// unread message IDs in one paged list call (`q = is:unread`) and diffs it
// against the local read flags — cheap, and naturally covers every folder and
// archived mail across the whole mailbox.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { listMessages } from "../gmail.server";
import { logError } from "../log.server";

// Hard cap on how many unread IDs we pull from Gmail in a single run, so a
// pathological mailbox can't make this unbounded. 5000 unread is already an
// extreme case; the cron re-runs every 15 minutes regardless.
const MAX_UNREAD_FETCH = 5000;
const LIST_PAGE_SIZE = 500;
const UPDATE_CHUNK = 500;
const LOCAL_IN_CHUNK = 500;

type LocalRow = { id: string; gmail_message_id: string };

export type ReadStateDiff = {
  /** Local row ids that should become is_read = true. */
  toMarkRead: string[];
  /** Local row ids that should become is_read = false. */
  toMarkUnread: string[];
};

/**
 * Pure diff: given the set of Gmail message IDs that are currently unread,
 * the locally-unread rows, and the locally-read rows that appear in Gmail's
 * unread set, produce the two id lists to update. Exported for unit tests.
 */
export function diffReadState(
  gmailUnread: Set<string>,
  localUnreadRows: LocalRow[],
  localReadRowsInUnreadSet: LocalRow[],
): ReadStateDiff {
  const toMarkRead: string[] = [];
  for (const row of localUnreadRows) {
    if (!gmailUnread.has(row.gmail_message_id)) toMarkRead.push(row.id);
  }
  const toMarkUnread: string[] = [];
  for (const row of localReadRowsInUnreadSet) {
    if (gmailUnread.has(row.gmail_message_id)) toMarkUnread.push(row.id);
  }
  return { toMarkRead, toMarkUnread };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Reconcile a single Gmail account's read flags with Gmail's canonical state.
 * Returns counts for logging. Each is_read change flows to the UI through the
 * existing emails realtime subscription, so no extra invalidation is needed.
 */
export async function syncReadState(
  accountId: string,
): Promise<{ marked_read: number; marked_unread: number; gmail_unread: number }> {
  // 1. Collect every currently-unread Gmail message id (whole mailbox).
  const gmailUnread = new Set<string>();
  let pageToken: string | undefined;
  while (gmailUnread.size < MAX_UNREAD_FETCH) {
    const list = await listMessages(accountId, {
      q: "is:unread -in:chats -in:spam -in:trash",
      maxResults: LIST_PAGE_SIZE,
      pageToken,
    });
    for (const m of list.messages ?? []) gmailUnread.add(m.id);
    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }

  // 2. Local rows currently flagged unread (small — bounded by unread count).
  const { data: localUnread, error: localUnreadErr } = await supabaseAdmin
    .from("emails")
    .select("id, gmail_message_id")
    .eq("gmail_account_id", accountId)
    .eq("is_read", false);
  if (localUnreadErr) throw localUnreadErr;

  // 3. Local rows flagged read that Gmail says are unread. Query only the ids
  //    in Gmail's unread set, chunked to keep the `in` lists bounded.
  const localReadInUnreadSet: LocalRow[] = [];
  for (const ids of chunk(Array.from(gmailUnread), LOCAL_IN_CHUNK)) {
    const { data, error } = await supabaseAdmin
      .from("emails")
      .select("id, gmail_message_id")
      .eq("gmail_account_id", accountId)
      .eq("is_read", true)
      .in("gmail_message_id", ids);
    if (error) throw error;
    if (data) localReadInUnreadSet.push(...(data as LocalRow[]));
  }

  const { toMarkRead, toMarkUnread } = diffReadState(
    gmailUnread,
    (localUnread ?? []) as LocalRow[],
    localReadInUnreadSet,
  );

  // 4. Apply batched updates.
  for (const ids of chunk(toMarkRead, UPDATE_CHUNK)) {
    const { error } = await supabaseAdmin.from("emails").update({ is_read: true }).in("id", ids);
    if (error) logError("read_state.mark_read_failed", { account_id: accountId, count: ids.length }, error);
  }
  for (const ids of chunk(toMarkUnread, UPDATE_CHUNK)) {
    const { error } = await supabaseAdmin.from("emails").update({ is_read: false }).in("id", ids);
    if (error)
      logError("read_state.mark_unread_failed", { account_id: accountId, count: ids.length }, error);
  }

  return {
    marked_read: toMarkRead.length,
    marked_unread: toMarkUnread.length,
    gmail_unread: gmailUnread.size,
  };
}
