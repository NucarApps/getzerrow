// The decisions the inbox list makes about *what to show*, lifted out of
// `routes/_authenticated/inbox.tsx` so they can be exercised without mounting
// a route that wires 31 server fns.
//
// Everything here is pure: rows in, rows (or a small decision object) out.
// The clock is always a parameter — the day headings are the only thing that
// depends on "now", and a test that has to wait for midnight is no test.

import { dayGroupLabel } from "@/lib/format";

/** The two non-folder pseudo-selections plus "the inbox itself". */
export type SpecialFolderSelection = "all" | "all_mail" | "no_rules";

/**
 * What the folder rail can be pointing at: one of the special views above, or
 * a folder id. Deliberately `string` — the id is opaque and comes from storage.
 */
export type FolderSelection = string;

/** The scope the `getInboxList` RPC understands. */
export type InboxScope = "all" | "all_mail" | "no_rules" | "folder";

const SPECIAL_VIEWS: ReadonlySet<string> = new Set<SpecialFolderSelection>([
  "all",
  "all_mail",
  "no_rules",
]);

/** True for the three views that are not backed by a `folders` row. */
export function isSpecialView(selection: FolderSelection): boolean {
  return SPECIAL_VIEWS.has(selection);
}

export type FolderSelectionResult = {
  /** The selection to query with — never a folder id this account lacks. */
  effective: FolderSelection;
  /**
   * True when the stored selection names a folder that does not belong to the
   * active account, so the caller should also reset the stored value.
   */
  isStale: boolean;
};

/**
 * Guard against a stale folder selection.
 *
 * The selection is stored globally rather than per account, so after the
 * active account changes a folder id from the *other* account can linger.
 * Querying it would scope the list to a folder holding none of this account's
 * mail, and the inbox would silently render empty.
 *
 * `foldersLoaded` is load-bearing: while the folder list is still in flight
 * every id looks stale, and resetting then would throw away a perfectly good
 * selection on every page load.
 */
export function resolveFolderSelection({
  selection,
  foldersLoaded,
  folderIds,
}: {
  selection: FolderSelection;
  foldersLoaded: boolean;
  folderIds: readonly string[];
}): FolderSelectionResult {
  if (isSpecialView(selection)) return { effective: selection, isStale: false };
  if (!foldersLoaded) return { effective: selection, isStale: false };
  if (folderIds.includes(selection)) return { effective: selection, isStale: false };
  return { effective: "all", isStale: true };
}

/**
 * Translate the selection into the `{ scope, folder_id }` pair the list RPC
 * takes. `folder_id` is only ever sent for a real folder — the special views
 * carry their meaning in `scope` alone, and sending both would let a stale id
 * narrow an "all mail" read.
 */
export function inboxListScope(selection: FolderSelection): {
  scope: InboxScope;
  folder_id: string | null;
} {
  if (selection === "all_mail") return { scope: "all_mail", folder_id: null };
  if (selection === "no_rules") return { scope: "no_rules", folder_id: null };
  if (selection === "all") return { scope: "all", folder_id: null };
  return { scope: "folder", folder_id: selection };
}

/** Header copy for the current view. */
export function labelForFolder(
  selection: FolderSelection,
  folders: readonly { id: string; name: string }[],
): string {
  if (selection === "all") return "All inbox";
  if (selection === "all_mail") return "All mail";
  if (selection === "no_rules") return "No rules";
  return folders.find((f) => f.id === selection)?.name ?? "Folder";
}

/**
 * Which account the page actually reads from.
 *
 * The remembered account wins only while it is still connected — after a
 * disconnect the id survives in local storage and would otherwise scope every
 * query to an account the user no longer has.
 */
export function resolveActiveAccount(
  remembered: string | null,
  accounts: readonly { id: string }[],
): string | null {
  if (remembered && accounts.some((a) => a.id === remembered)) return remembered;
  return accounts[0]?.id ?? null;
}

/**
 * Trim the fetched page to its window and, when searching, splice in the rows
 * fetched separately for Gmail hits that fall outside the local corpus.
 *
 * The list is always fetched with one sentinel row past `pageSize` so the
 * caller can tell "there is another page" from "this is the end"; that row
 * must never be rendered, hence the unconditional slice.
 *
 * Order matters: the server ranked the window, so the extras are appended
 * rather than merged by date, and ids already in the window are dropped so a
 * Gmail hit we also hold locally does not render twice.
 */
export function mergeSearchRows<T extends { id: string }>({
  rows,
  pageSize,
  isSearching,
  extraRows,
}: {
  rows: readonly T[];
  pageSize: number;
  isSearching: boolean;
  extraRows: readonly T[];
}): T[] {
  const windowRows = rows.slice(0, pageSize);
  if (!isSearching) return windowRows;
  if (extraRows.length === 0) return windowRows;
  const seen = new Set(windowRows.map((r) => r.id));
  const merged = [...windowRows];
  for (const r of extraRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  return merged;
}

/**
 * Ids of the rows that still need a decrypt round-trip.
 *
 * The paginated list arrives already decrypted, so those rows are skipped. The
 * ones that are not are (a) search results, which come from a raw metadata
 * query, and (b) rows spliced in by a realtime INSERT, which carry only the
 * encrypted columns. The tell is an *absent* `subject` key — a row that was
 * decrypted and genuinely has no subject carries `subject: null`, and asking
 * for it again would be a wasted round-trip per render.
 */
export function idsNeedingListFields(
  rows: readonly { id: string; subject?: string | null }[],
): string[] {
  return rows.filter((r) => r.subject === undefined).map((r) => r.id);
}

/** The plaintext fields the decrypt round-trip returns for one row. */
export type ListFields = {
  ai_summary: string | null;
  classification_reason: string | null;
  subject: string | null;
  snippet: string | null;
  from_name: string | null;
  to_addrs: string | null;
  cc: string | null;
};

/**
 * Overlay the decrypted fields onto the rows that have them.
 *
 * Rows with no entry are returned by identity, and an empty map returns the
 * input array itself — both matter for the memoised row components, which
 * re-render on any changed reference.
 */
export function applyListFields<T extends { id: string }>(
  rows: readonly T[],
  fields: ReadonlyMap<string, ListFields> | undefined,
): readonly T[] {
  if (!fields || fields.size === 0) return rows;
  return rows.map((r) => {
    const extra = fields.get(r.id);
    return extra ? { ...r, ...extra } : r;
  });
}

/**
 * The day heading to render above each row, or null for no heading.
 *
 * A heading is emitted only when the row's day differs from the previous
 * row's, so a page covering one day shows one heading. Placeholder rows —
 * reconstructed from the metadata cache while the real read is in flight —
 * are skipped: they carry no trustworthy timestamp, and labelling them would
 * make the headings jump once the real rows land.
 */
export function dayGroupHeadings(
  rows: readonly { received_at: string | null; __placeholder?: boolean }[],
  now: Date,
): (string | null)[] {
  return rows.map((row, i) => {
    const label = row.__placeholder ? null : dayGroupLabel(row.received_at, now);
    if (!label) return null;
    const prev = i > 0 ? rows[i - 1] : undefined;
    const prevLabel = prev && !prev.__placeholder ? dayGroupLabel(prev.received_at, now) : null;
    return label === prevLabel ? null : label;
  });
}
