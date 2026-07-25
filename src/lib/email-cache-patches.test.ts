// inbox.tsx's optimistic patches had no coverage at all, and were inlined at
// fourteen call sites — so the same action could behave differently depending on
// whether it came from the context menu, a swipe, or the reader toolbar.
import { describe, it, expect } from "vitest";
import {
  patchMovedToInbox,
  patchMovedToFolder,
  patchArchived,
  patchReadState,
  patchRemoved,
  type PatchableEmail,
} from "./email-cache-patches";

function row(over: Partial<PatchableEmail> & { id: string }): PatchableEmail {
  return {
    is_read: false,
    is_archived: false,
    folder_id: null,
    classified_by: null,
    raw_labels: ["INBOX"],
    ...over,
  };
}

const list = () => [
  row({ id: "a", folder_id: "f1", is_archived: true, raw_labels: [] }),
  row({ id: "b" }),
];

describe("patchMovedToInbox", () => {
  it("clears the folder, un-archives, restores INBOX, and stamps manual_inbox", () => {
    const out = patchMovedToInbox(list(), "a")!;
    expect(out[0]).toMatchObject({
      id: "a",
      folder_id: null,
      is_archived: false,
      raw_labels: ["INBOX"],
      classified_by: "manual_inbox",
    });
  });

  it("does not duplicate an INBOX label that is already present", () => {
    const out = patchMovedToInbox([row({ id: "a", raw_labels: ["INBOX", "Label_1"] })], "a")!;
    expect(out[0].raw_labels).toEqual(["INBOX", "Label_1"]);
  });

  it("preserves other labels", () => {
    const out = patchMovedToInbox([row({ id: "a", raw_labels: ["Label_1"] })], "a")!;
    expect(out[0].raw_labels).toEqual(["Label_1", "INBOX"]);
  });
});

describe("patchMovedToFolder", () => {
  it("files, archives, and drops INBOX in one step", () => {
    // These belong together: a copy that forgot the label left the row visible
    // in the inbox until the next refetch.
    const out = patchMovedToFolder(list(), "b", "f2")!;
    expect(out[1]).toMatchObject({
      id: "b",
      folder_id: "f2",
      is_archived: true,
      raw_labels: [],
    });
  });

  it("keeps the existing classified_by unless told otherwise", () => {
    const out = patchMovedToFolder([row({ id: "b", classified_by: "ai" })], "b", "f2")!;
    expect(out[0].classified_by).toBe("ai");
  });

  it("stamps classified_by when the caller supplies one", () => {
    const out = patchMovedToFolder([row({ id: "b" })], "b", "f2", {
      classifiedBy: "manual_move",
    })!;
    expect(out[0].classified_by).toBe("manual_move");
  });
});

describe("patchArchived", () => {
  it("archives in place and drops INBOX", () => {
    const out = patchArchived(list(), "b")!;
    expect(out[1]).toMatchObject({ id: "b", is_archived: true, raw_labels: [] });
  });

  it("leaves the row in the list (unlike trash)", () => {
    expect(patchArchived(list(), "b")).toHaveLength(2);
  });

  it("keeps the folder assignment", () => {
    const out = patchArchived([row({ id: "a", folder_id: "f1" })], "a")!;
    expect(out[0].folder_id).toBe("f1");
  });
});

describe("patchReadState", () => {
  it("marks read", () => {
    expect(patchReadState(list(), "b", true)![1].is_read).toBe(true);
  });

  it("marks unread", () => {
    const out = patchReadState([row({ id: "b", is_read: true })], "b", false)!;
    expect(out[0].is_read).toBe(false);
  });
});

describe("patchRemoved", () => {
  it("drops the row", () => {
    const out = patchRemoved(list(), "a")!;
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("b");
  });
});

describe("every patch — shared invariants", () => {
  const patches: Array<[string, (rows: PatchableEmail[] | undefined) => unknown]> = [
    ["patchMovedToInbox", (r) => patchMovedToInbox(r, "a")],
    ["patchMovedToFolder", (r) => patchMovedToFolder(r, "a", "f9")],
    ["patchArchived", (r) => patchArchived(r, "a")],
    ["patchReadState", (r) => patchReadState(r, "a", true)],
    ["patchRemoved", (r) => patchRemoved(r, "a")],
  ];

  for (const [name, apply] of patches) {
    // react-query hands the updater `undefined` for a key it hasn't populated;
    // every patch runs against ALL ["emails"] queries, so this is routine.
    it(`${name} passes undefined through instead of throwing`, () => {
      expect(apply(undefined)).toBeUndefined();
    });

    it(`${name} leaves other rows untouched`, () => {
      const rows = list();
      const out = apply(rows) as PatchableEmail[];
      const other = out.find((r) => r.id === "b");
      expect(other).toEqual(rows[1]);
    });

    it(`${name} does not mutate the input array or its rows`, () => {
      const rows = list();
      const snapshot = JSON.stringify(rows);
      apply(rows);
      expect(JSON.stringify(rows)).toBe(snapshot);
    });

    it(`${name} keeps the list length (except patchRemoved, which drops one)`, () => {
      const out = apply(list()) as PatchableEmail[];
      expect(out).toHaveLength(name === "patchRemoved" ? 1 : 2);
    });
  }

  it("a patch for an unknown id changes nothing", () => {
    const rows = list();
    expect(patchArchived(rows, "nope")).toEqual(rows);
    expect(patchRemoved(rows, "nope")).toEqual(rows);
  });
});
