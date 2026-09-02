import { describe, expect, it } from "vitest";
import {
  advancePageCursors,
  canGoNext,
  canGoPrev,
  cursorForPage,
  hasMorePages,
  nextPageAction,
  nextPageHint,
  type PagingState,
} from "./inbox-paging";

function paging(over: Partial<PagingState> = {}): PagingState {
  return {
    isSearching: false,
    hasMoreSearch: false,
    hasMoreLocal: false,
    canPullFromGmail: false,
    pullPending: false,
    ...over,
  };
}

describe("hasMorePages", () => {
  it.each([
    ["a full page plus the sentinel", 51, 50, true],
    ["exactly a full page", 50, 50, false],
    ["a short page", 12, 50, false],
    ["nothing at all", 0, 50, false],
  ])("reports %s", (_label, rowCount, pageSize, expected) => {
    expect(hasMorePages(rowCount, pageSize)).toBe(expected);
  });
});

describe("cursorForPage", () => {
  const cursors = [null, "2026-03-01T00:00:00Z", "2026-02-01T00:00:00Z"];

  it("starts page 1 at the newest row", () => {
    expect(cursorForPage(cursors, 1)).toBeNull();
  });

  it("reads the recorded bound for a later page", () => {
    expect(cursorForPage(cursors, 3)).toBe("2026-02-01T00:00:00Z");
  });

  it("falls back to the start for a page it has no cursor for", () => {
    // Reachable when a folder switch resets the cursors but not the page in
    // the same tick; re-reading page 1 beats reading a page of nothing.
    expect(cursorForPage(cursors, 9)).toBeNull();
    expect(cursorForPage([], 1)).toBeNull();
  });
});

describe("advancePageCursors", () => {
  it("records the bound for page 2 while on page 1", () => {
    expect(advancePageCursors([null], 1, "2026-03-01T00:00:00Z")).toStrictEqual([
      null,
      "2026-03-01T00:00:00Z",
    ]);
  });

  it("keeps the cursors indexed by page across a back-then-forward walk", () => {
    // Without the slice this would push a second cursor for page 2 and every
    // later page would read one page's worth of the wrong window.
    const afterPage2 = advancePageCursors([null], 1, "march");
    const backOnPage1 = advancePageCursors(afterPage2, 1, "march-again");
    expect(backOnPage1).toStrictEqual([null, "march-again"]);
  });

  it("truncates cursors for pages beyond the one being left", () => {
    const deep = [null, "march", "february", "january"];
    expect(advancePageCursors(deep, 2, "march-refreshed")).toStrictEqual([
      null,
      "march",
      "march-refreshed",
    ]);
  });

  it("does not mutate the array it was given", () => {
    const cursors = [null, "march"];
    advancePageCursors(cursors, 1, "april");
    expect(cursors).toStrictEqual([null, "march"]);
  });

  it("records a null bound when the page ended with an undated row", () => {
    // The caller passes null when the last row has no received_at; the next
    // read then starts from the top rather than from an invalid bound.
    expect(advancePageCursors([null], 1, null)).toStrictEqual([null, null]);
  });
});

describe("nextPageAction", () => {
  it("advances when another local page is already held", () => {
    expect(nextPageAction(paging({ hasMoreLocal: true }))).toBe("page");
  });

  it("prefers the local page over a Gmail pull", () => {
    expect(nextPageAction(paging({ hasMoreLocal: true, canPullFromGmail: true }))).toBe("page");
  });

  it("pulls older mail once the local pages run out in a mirrored folder", () => {
    expect(nextPageAction(paging({ canPullFromGmail: true }))).toBe("pull");
  });

  it("does nothing while a pull is already in flight", () => {
    expect(nextPageAction(paging({ canPullFromGmail: true, pullPending: true }))).toBe("none");
  });

  it("does nothing at the end of a view with no Gmail label behind it", () => {
    expect(nextPageAction(paging())).toBe("none");
  });

  it("advances a search by offset when a sentinel row came back", () => {
    expect(nextPageAction(paging({ isSearching: true, hasMoreSearch: true }))).toBe("page");
  });

  it("never pulls a folder's older mail from inside a search", () => {
    // The pull is scoped to the folder, not the query, so it would fetch
    // messages that have nothing to do with what was typed.
    expect(
      nextPageAction(paging({ isSearching: true, canPullFromGmail: true, hasMoreLocal: true })),
    ).toBe("none");
  });
});

describe("canGoNext", () => {
  it.each([
    ["another local page", paging({ hasMoreLocal: true }), true],
    ["a mirrored folder at its end", paging({ canPullFromGmail: true }), true],
    ["a pull already in flight", paging({ canPullFromGmail: true, pullPending: true }), true],
    ["the end of an unmirrored view", paging(), false],
    ["a search with more results", paging({ isSearching: true, hasMoreSearch: true }), true],
    ["the last page of a search", paging({ isSearching: true, canPullFromGmail: true }), false],
  ])("enables Next for %s: %s", (_label, state, expected) => {
    expect(canGoNext(state)).toBe(expected);
  });

  it("stays enabled while a pull runs even though Next would do nothing", () => {
    // Deliberate: the button reads as busy rather than finished, so it does
    // not flicker back to enabled the moment the request settles.
    const state = paging({ canPullFromGmail: true, pullPending: true });
    expect(nextPageAction(state)).toBe("none");
    expect(canGoNext(state)).toBe(true);
  });
});

describe("canGoPrev", () => {
  it.each([
    [1, false],
    [2, true],
    [9, true],
  ])("answers %s for page %i", (page, expected) => {
    expect(canGoPrev(page)).toBe(expected);
  });
});

describe("nextPageHint", () => {
  it("warns that Next will hit Gmail", () => {
    expect(nextPageHint(paging({ canPullFromGmail: true }))).toBe("Pull next 50 from Gmail");
  });

  it("says nothing when Next just advances a held page", () => {
    expect(nextPageHint(paging({ hasMoreLocal: true }))).toBe("");
    expect(nextPageHint(paging({ isSearching: true, hasMoreSearch: true }))).toBe("");
  });

  it("explains a disabled Next", () => {
    expect(nextPageHint(paging())).toBe("No more results in this view");
    expect(nextPageHint(paging({ isSearching: true }))).toBe("No more results in this view");
  });

  it("still promises a pull while one is in flight", () => {
    // canGoNext keeps the button enabled-but-busy here, so the hint has to
    // agree with it rather than claim the view is exhausted.
    expect(nextPageHint(paging({ canPullFromGmail: true, pullPending: true }))).toBe(
      "Pull next 50 from Gmail",
    );
  });
});
