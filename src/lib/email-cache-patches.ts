// Optimistic cache patches for email list rows.
//
// The inbox performs each mail action optimistically: patch the react-query
// cache so the row moves immediately, fire the server fn, and invalidate on
// failure to roll back. The PATCH part was inlined at fourteen call sites in
// inbox.tsx — three separate copies of move-to-inbox, three of archive, two of
// mark-read, two of move-to-folder — so the same action behaved subtly
// differently depending on whether you used the context menu, the swipe, or the
// reader's toolbar.
//
// These are pure array transformations. They take the shape react-query's
// updater gives them (`T[] | undefined`) and return the same, so they drop
// straight into `setQueriesData`. Kept free of react-query and React so they
// can be tested without a DOM — this repo's vitest runs in `node`.
import { withInbox, withoutInbox } from "./email-text";

/** The row fields these patches touch. Structurally satisfied by the inbox's
 *  fuller Email type, so it stays usable from the route without a cast. */
export type PatchableEmail = {
  id: string;
  is_read: boolean;
  is_archived: boolean;
  folder_id: string | null;
  classified_by: string | null;
  raw_labels?: string[] | null;
};

type Rows<T> = T[] | undefined;

/** Apply `fn` to the row with `id`, leaving every other row identical. */
function patchRow<T extends PatchableEmail>(rows: Rows<T>, id: string, fn: (row: T) => T): Rows<T> {
  return rows?.map((r) => (r.id === id ? fn(r) : r));
}

/**
 * Un-file a message back to the inbox.
 *
 * Clears the folder, un-archives, restores the INBOX label, and stamps
 * `manual_inbox` so the classifier records that a human decided this.
 */
export function patchMovedToInbox<T extends PatchableEmail>(rows: Rows<T>, id: string): Rows<T> {
  return patchRow(rows, id, (r) => ({
    ...r,
    folder_id: null,
    is_archived: false,
    raw_labels: withInbox(r.raw_labels),
    classified_by: "manual_inbox",
  }));
}

/**
 * File a message into a folder.
 *
 * Archives it and drops the INBOX label, because a filed message leaves the
 * inbox — the two are one action, and a copy that forgot the label left the row
 * visible until the next refetch.
 */
export function patchMovedToFolder<T extends PatchableEmail>(
  rows: Rows<T>,
  id: string,
  folderId: string,
  opts: { classifiedBy?: string } = {},
): Rows<T> {
  return patchRow(rows, id, (r) => ({
    ...r,
    folder_id: folderId,
    is_archived: true,
    raw_labels: withoutInbox(r.raw_labels),
    classified_by: opts.classifiedBy ?? r.classified_by,
  }));
}

/** Archive in place — the row stays in the list but reads as archived. */
export function patchArchived<T extends PatchableEmail>(rows: Rows<T>, id: string): Rows<T> {
  return patchRow(rows, id, (r) => ({
    ...r,
    is_archived: true,
    raw_labels: withoutInbox(r.raw_labels),
  }));
}

/** Mark read/unread. */
export function patchReadState<T extends PatchableEmail>(
  rows: Rows<T>,
  id: string,
  isRead: boolean,
): Rows<T> {
  return patchRow(rows, id, (r) => ({ ...r, is_read: isRead }));
}

/**
 * Drop the row from the list entirely.
 *
 * Used for trash, and for swipe-archive — where the row should leave the
 * current view rather than sit there greyed out.
 */
export function patchRemoved<T extends PatchableEmail>(rows: Rows<T>, id: string): Rows<T> {
  return rows?.filter((r) => r.id !== id);
}
