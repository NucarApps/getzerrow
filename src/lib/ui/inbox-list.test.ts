import { describe, expect, it } from "vitest";
import {
  applyListFields,
  dayGroupHeadings,
  idsNeedingListFields,
  inboxListScope,
  isSpecialView,
  labelForFolder,
  mergeSearchRows,
  resolveActiveAccount,
  resolveFolderSelection,
  type ListFields,
} from "./inbox-list";

const FOLDERS = [
  { id: "f-invoices", name: "Invoices" },
  { id: "f-travel", name: "Travel" },
];

describe("isSpecialView", () => {
  it.each([
    ["all", true],
    ["all_mail", true],
    ["no_rules", true],
    ["f-invoices", false],
    ["", false],
    // Not a view — a folder id that happens to spell a prototype key must not
    // borrow Object.prototype's answer.
    ["toString", false],
  ] as const)("answers %s for %s", (selection, expected) => {
    expect(isSpecialView(selection)).toBe(expected);
  });
});

describe("resolveFolderSelection", () => {
  const folderIds = FOLDERS.map((f) => f.id);

  it.each(["all", "all_mail", "no_rules"])(
    "leaves the special view %s alone even with no folders loaded",
    (selection) => {
      expect(
        resolveFolderSelection({ selection, foldersLoaded: false, folderIds: [] }),
      ).toStrictEqual({ effective: selection, isStale: false });
    },
  );

  it("keeps a folder that belongs to the active account", () => {
    expect(
      resolveFolderSelection({ selection: "f-travel", foldersLoaded: true, folderIds }),
    ).toStrictEqual({ effective: "f-travel", isStale: false });
  });

  it("falls back to the inbox and flags a folder from another account", () => {
    expect(
      resolveFolderSelection({ selection: "f-other-account", foldersLoaded: true, folderIds }),
    ).toStrictEqual({ effective: "all", isStale: true });
  });

  it("does not judge a folder while the folder list is still loading", () => {
    // Resetting here would discard a good selection on every page load: before
    // the folders arrive every id looks like it belongs to another account.
    expect(
      resolveFolderSelection({ selection: "f-travel", foldersLoaded: false, folderIds: [] }),
    ).toStrictEqual({ effective: "f-travel", isStale: false });
  });

  it("treats an account with zero folders as making every folder id stale", () => {
    expect(
      resolveFolderSelection({ selection: "f-travel", foldersLoaded: true, folderIds: [] }),
    ).toStrictEqual({ effective: "all", isStale: true });
  });
});

describe("inboxListScope", () => {
  it.each([
    ["all", { scope: "all", folder_id: null }],
    ["all_mail", { scope: "all_mail", folder_id: null }],
    ["no_rules", { scope: "no_rules", folder_id: null }],
  ] as const)("sends %s as a scope with no folder id", (selection, expected) => {
    expect(inboxListScope(selection)).toStrictEqual(expected);
  });

  it("sends a folder id only for a real folder", () => {
    expect(inboxListScope("f-invoices")).toStrictEqual({
      scope: "folder",
      folder_id: "f-invoices",
    });
  });
});

describe("labelForFolder", () => {
  it.each([
    ["all", "All inbox"],
    ["all_mail", "All mail"],
    ["no_rules", "No rules"],
  ])("names the %s view", (selection, expected) => {
    expect(labelForFolder(selection, FOLDERS)).toBe(expected);
  });

  it("uses the folder's own name", () => {
    expect(labelForFolder("f-travel", FOLDERS)).toBe("Travel");
  });

  it("says 'Folder' rather than blank for an id it cannot resolve", () => {
    // Reached while the folder query is still in flight; an empty heading
    // would collapse the header row.
    expect(labelForFolder("f-travel", [])).toBe("Folder");
  });
});

describe("resolveActiveAccount", () => {
  const accounts = [{ id: "acc-1" }, { id: "acc-2" }];

  it("honours the remembered account while it is still connected", () => {
    expect(resolveActiveAccount("acc-2", accounts)).toBe("acc-2");
  });

  it("falls back to the first account when the remembered one was disconnected", () => {
    expect(resolveActiveAccount("acc-gone", accounts)).toBe("acc-1");
  });

  it("falls back to the first account when nothing is remembered", () => {
    expect(resolveActiveAccount(null, accounts)).toBe("acc-1");
  });

  it("returns null when no account is connected at all", () => {
    expect(resolveActiveAccount("acc-1", [])).toBeNull();
  });
});

describe("mergeSearchRows", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("drops the sentinel row that only signals 'there is more'", () => {
    expect(mergeSearchRows({ rows, pageSize: 2, isSearching: false, extraRows: [] })).toStrictEqual(
      [{ id: "a" }, { id: "b" }],
    );
  });

  it("ignores Gmail extras outside a search", () => {
    expect(
      mergeSearchRows({ rows, pageSize: 10, isSearching: false, extraRows: [{ id: "z" }] }),
    ).toStrictEqual(rows);
  });

  it("appends Gmail-only hits after the server-ranked window", () => {
    // Order is the contract: the server ranked the window, so extras go last
    // rather than being re-sorted into it.
    expect(
      mergeSearchRows({
        rows,
        pageSize: 10,
        isSearching: true,
        extraRows: [{ id: "z" }, { id: "y" }],
      }),
    ).toStrictEqual([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "z" }, { id: "y" }]);
  });

  it("never renders a hit twice when it is also held locally", () => {
    expect(
      mergeSearchRows({
        rows,
        pageSize: 10,
        isSearching: true,
        extraRows: [{ id: "b" }, { id: "z" }],
      }),
    ).toStrictEqual([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "z" }]);
  });

  it("deduplicates repeats inside the extras themselves", () => {
    expect(
      mergeSearchRows({
        rows: [],
        pageSize: 10,
        isSearching: true,
        extraRows: [{ id: "z" }, { id: "z" }],
      }),
    ).toStrictEqual([{ id: "z" }]);
  });

  it("still trims the sentinel while searching", () => {
    expect(
      mergeSearchRows({ rows, pageSize: 2, isSearching: true, extraRows: [{ id: "c" }] }),
    ).toStrictEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
  });

  it("returns nothing for an empty page with no extras", () => {
    expect(
      mergeSearchRows({ rows: [], pageSize: 50, isSearching: true, extraRows: [] }),
    ).toStrictEqual([]);
  });
});

describe("idsNeedingListFields", () => {
  it("asks only for rows whose subject key is absent", () => {
    // An absent key means the row arrived encrypted; an explicit null means it
    // was decrypted and genuinely has no subject, so asking again would burn a
    // round-trip on every render.
    expect(
      idsNeedingListFields([
        { id: "decrypted", subject: "Invoice" },
        { id: "empty-subject", subject: null },
        { id: "raw" },
      ]),
    ).toStrictEqual(["raw"]);
  });

  it("asks for nothing when the whole page arrived decrypted", () => {
    expect(idsNeedingListFields([{ id: "a", subject: null }])).toStrictEqual([]);
  });

  it("handles an empty page", () => {
    expect(idsNeedingListFields([])).toStrictEqual([]);
  });
});

describe("applyListFields", () => {
  const fields: ListFields = {
    ai_summary: "Invoice due Friday",
    classification_reason: "matched vendor rule",
    subject: "Invoice #7",
    snippet: "Please remit",
    from_name: "Acme Billing",
    to_addrs: "me@example.com",
    cc: null,
  };
  const rows = [
    { id: "a", is_read: false },
    { id: "b", is_read: true },
  ];

  it("overlays the decrypted fields onto the row that has them", () => {
    expect(applyListFields(rows, new Map([["a", fields]]))).toStrictEqual([
      { id: "a", is_read: false, ...fields },
      { id: "b", is_read: true },
    ]);
  });

  it("returns the input array itself when there is nothing to overlay", () => {
    // Reference identity matters: the rows feed a memoised list component, and
    // a fresh array every render would defeat the memo.
    expect(applyListFields(rows, new Map())).toBe(rows);
    expect(applyListFields(rows, undefined)).toBe(rows);
  });

  it("leaves rows with no entry referentially untouched", () => {
    const out = applyListFields(rows, new Map([["a", fields]]));
    expect(out[1]).toBe(rows[1]);
  });

  it("does not invent rows for ids that are no longer on the page", () => {
    expect(applyListFields(rows, new Map([["gone", fields]]))).toStrictEqual(rows);
  });
});

describe("dayGroupHeadings", () => {
  // Fixed clock; the suite pins TZ to UTC, so calendar days line up with ISO.
  const now = new Date("2026-03-10T12:00:00Z");
  const today = "2026-03-10T09:00:00Z";
  const alsoToday = "2026-03-10T08:00:00Z";
  const yesterday = "2026-03-09T22:00:00Z";
  const thisMonth = "2026-02-20T10:00:00Z";
  const earlier = "2026-01-02T10:00:00Z";

  it("labels the first row and stays silent for the rest of its day", () => {
    expect(
      dayGroupHeadings([{ received_at: today }, { received_at: alsoToday }], now),
    ).toStrictEqual(["Today", null]);
  });

  it("emits a fresh heading at each day boundary", () => {
    expect(
      dayGroupHeadings(
        [
          { received_at: today },
          { received_at: alsoToday },
          { received_at: yesterday },
          { received_at: thisMonth },
          { received_at: earlier },
        ],
        now,
      ),
    ).toStrictEqual(["Today", null, "Yesterday", "This month", "Earlier"]);
  });

  it("skips rows with no usable timestamp without breaking the run", () => {
    expect(
      dayGroupHeadings(
        [{ received_at: today }, { received_at: null }, { received_at: yesterday }],
        now,
      ),
    ).toStrictEqual(["Today", null, "Yesterday"]);
  });

  it("gives placeholder rows no heading of their own", () => {
    // Rows rebuilt from the metadata cache carry no trustworthy timestamp;
    // labelling them would make the headings jump when the real rows land.
    expect(
      dayGroupHeadings([{ received_at: today, __placeholder: true }, { received_at: today }], now),
    ).toStrictEqual([null, "Today"]);
  });

  // CHARACTERIZATION(inbox-day-heading-repeats-after-placeholder): a placeholder
  // row between two rows of the same day resets the comparison, so the day
  // heading is drawn a second time mid-list — flip when fixed
  it("repeats the day heading after a placeholder interrupts the run", () => {
    expect(
      dayGroupHeadings(
        [
          { received_at: today },
          { received_at: alsoToday, __placeholder: true },
          { received_at: alsoToday },
        ],
        now,
      ),
    ).toStrictEqual(["Today", null, "Today"]);
  });

  it("returns nothing for an empty list", () => {
    expect(dayGroupHeadings([], now)).toStrictEqual([]);
  });
});
