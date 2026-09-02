// Inbox pagination, lifted out of `routes/_authenticated/inbox.tsx`.
//
// The inbox pages two different ways at once. Search is offset-based (the
// query key carries the page number and the RPC applies LIMIT/OFFSET). The
// folder/inbox list is keyset-based: page N is "received_at < cursors[N-1]".
// Getting the cursor bookkeeping wrong does not throw — it silently skips or
// repeats a page — so it is worth asserting rather than eyeballing.

/**
 * Every list read asks for one row past the window. Its presence is the only
 * signal that another page exists, and it must never be rendered.
 */
export function hasMorePages(rowCount: number, pageSize: number): boolean {
  return rowCount > pageSize;
}

/**
 * Record the cursor for the page we are about to move to.
 *
 * `cursors[i]` is the `received_at <` bound for page `i + 1`, so `cursors[0]`
 * is always null (page 1 starts at the newest row). The slice is the important
 * part: going back and then forward again must *overwrite* the stale cursor
 * for the page being re-entered rather than push a second one, otherwise the
 * array grows on every back-and-forth and the page number stops indexing it.
 */
export function advancePageCursors(
  cursors: readonly (string | null)[],
  page: number,
  lastReceivedAt: string | null,
): (string | null)[] {
  const next = cursors.slice(0, page);
  next.push(lastReceivedAt);
  return next;
}

/** The cursor to read page `page` with. Page 1 has none. */
export function cursorForPage(cursors: readonly (string | null)[], page: number): string | null {
  return cursors[page - 1] ?? null;
}

export type PagingState = {
  isSearching: boolean;
  /** A sentinel row came back from the search RPC. */
  hasMoreSearch: boolean;
  /** A sentinel row came back from the list RPC. */
  hasMoreLocal: boolean;
  /** This view is a folder mirrored to a Gmail label, so older mail can be pulled. */
  canPullFromGmail: boolean;
  /** A pull is already in flight. */
  pullPending: boolean;
};

/**
 * What the Next button actually does in the current state.
 *
 * - `"page"`: another page is already available locally, just advance.
 * - `"pull"`: we are at the end of what we hold, but this folder mirrors a
 *   Gmail label, so Next means "fetch the next 50 from Gmail" first.
 * - `"none"`: nothing to do; the button is disabled.
 *
 * Search never falls through to a pull: the Gmail search path is driven by the
 * search box itself, and pulling a *folder's* older mail from inside a search
 * result would fetch messages that have nothing to do with the query.
 */
export function nextPageAction(state: PagingState): "page" | "pull" | "none" {
  if (state.isSearching) return state.hasMoreSearch ? "page" : "none";
  if (state.hasMoreLocal) return "page";
  if (state.canPullFromGmail && !state.pullPending) return "pull";
  return "none";
}

/**
 * Whether Next is enabled.
 *
 * Deliberately not `nextPageAction(...) !== "none"`: a pull already in flight
 * still counts as "there is more", so the button reads as disabled-because-busy
 * rather than disabled-because-finished, and stops flickering back to enabled
 * between the request and its result.
 */
export function canGoNext(state: PagingState): boolean {
  if (state.isSearching) return state.hasMoreSearch;
  return state.hasMoreLocal || state.canPullFromGmail;
}

/** Prev is only ever available off page 1. */
export function canGoPrev(page: number): boolean {
  return page > 1;
}

/**
 * Tooltip for the Next button, mirroring `nextPageAction` — "Pull next 50"
 * has to appear exactly when pressing Next would hit Gmail rather than just
 * advance, or the button lies about the round-trip it is about to make.
 */
export function nextPageHint(state: PagingState): string {
  if (!canGoNext(state)) return "No more results in this view";
  if (!state.isSearching && !state.hasMoreLocal) return "Pull next 50 from Gmail";
  return "";
}
