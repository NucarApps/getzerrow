import { describe, it, expect } from "vitest";
import {
  EMPTY_MANUAL_CONTACT,
  allVisibleSelected,
  isValidContactEmail,
  manualContactPayload,
  pickedPeople,
  selectAllVisible,
  toggleFolder,
  togglePerson,
  type ManualContactForm,
} from "./add-contacts";

const form = (over: Partial<ManualContactForm> = {}): ManualContactForm => ({
  ...EMPTY_MANUAL_CONTACT,
  ...over,
});

const person = (email: string, name: string | null = null) => ({ email, name });

describe("isValidContactEmail", () => {
  it.each(["jane@example.com", "a@b.c", "jane.doe+tag@sub.example.co.uk", "JANE@EXAMPLE.COM"])(
    "accepts %s",
    (email) => {
      expect(isValidContactEmail(email)).toBe(true);
    },
  );

  it.each([
    ["", "empty"],
    ["jane", "no @ at all"],
    ["jane@example", "no dot in the domain"],
    ["@example.com", "nothing before the @"],
    ["jane@.com", "nothing between the @ and the dot"],
  ])("rejects %s (%s)", (email) => {
    expect(isValidContactEmail(email)).toBe(false);
  });

  // The gate is a courtesy, not validation: the server is the authority, and
  // the pattern is unanchored, so pasted text around a real address passes.
  it("is loose by design — surrounding text and inner spaces pass", () => {
    expect(isValidContactEmail("Jane Doe <jane@example.com>")).toBe(true);
    expect(isValidContactEmail("jane doe@example.com")).toBe(true);
    expect(isValidContactEmail("a@b@c.d")).toBe(true);
  });
});

describe("manualContactPayload", () => {
  it("stores nothing rather than an empty string for a field left blank", () => {
    expect(manualContactPayload(form({ email: "jane@example.com" }))).toStrictEqual({
      email: "jane@example.com",
      name: null,
      title: null,
      company: null,
      phone: null,
      website: null,
      linkedin: null,
      twitter: null,
    });
  });

  it("carries every filled field through untouched", () => {
    expect(
      manualContactPayload({
        email: "jane@example.com",
        name: "Jane Doe",
        title: "CTO",
        company: "Acme",
        phone: "555-0100",
        website: "acme.test",
        linkedin: "in/jane",
        twitter: "@jane",
      }),
    ).toStrictEqual({
      email: "jane@example.com",
      name: "Jane Doe",
      title: "CTO",
      company: "Acme",
      phone: "555-0100",
      website: "acme.test",
      linkedin: "in/jane",
      twitter: "@jane",
    });
  });

  it("does not trim, so whitespace the user typed is preserved verbatim", () => {
    expect(manualContactPayload(form({ email: "a@b.c", name: "  Jane  " })).name).toBe("  Jane  ");
  });

  it("keeps a whitespace-only field, since only the empty string is nulled", () => {
    expect(manualContactPayload(form({ email: "a@b.c", title: " " })).title).toBe(" ");
  });
});

describe("togglePerson", () => {
  it("adds someone who is not selected", () => {
    expect([...togglePerson(new Set(), "a@x.test")]).toStrictEqual(["a@x.test"]);
  });

  it("removes someone who already is", () => {
    expect([...togglePerson(new Set(["a@x.test", "b@x.test"]), "a@x.test")]).toStrictEqual([
      "b@x.test",
    ]);
  });

  it("leaves the previous selection untouched, so React sees a new set", () => {
    const before = new Set(["a@x.test"]);
    const after = togglePerson(before, "b@x.test");
    expect([...before]).toStrictEqual(["a@x.test"]);
    expect(after).not.toBe(before);
  });
});

describe("toggleFolder", () => {
  it("adds a folder to the scope, keeping the order it was picked in", () => {
    expect(toggleFolder(["f1"], "f2")).toStrictEqual(["f1", "f2"]);
  });

  it("removes a folder already in the scope", () => {
    expect(toggleFolder(["f1", "f2", "f3"], "f2")).toStrictEqual(["f1", "f3"]);
  });

  it("does not mutate the previous scope", () => {
    const before = ["f1"];
    expect(toggleFolder(before, "f2")).not.toBe(before);
    expect(before).toStrictEqual(["f1"]);
  });
});

describe("allVisibleSelected", () => {
  it("is true only when every listed person is selected", () => {
    const items = [person("a@x.test"), person("b@x.test")];
    expect(allVisibleSelected(items, new Set(["a@x.test", "b@x.test"]))).toBe(true);
    expect(allVisibleSelected(items, new Set(["a@x.test"]))).toBe(false);
  });

  // Otherwise the header control would read "Unselect all" over an empty list.
  it("is false for an empty list, however much is selected elsewhere", () => {
    expect(allVisibleSelected([], new Set(["a@x.test"]))).toBe(false);
    expect(allVisibleSelected([], new Set())).toBe(false);
  });

  it("ignores selections that are not currently listed", () => {
    expect(allVisibleSelected([person("a@x.test")], new Set(["a@x.test", "z@x.test"]))).toBe(true);
  });
});

describe("selectAllVisible", () => {
  it("selects everything listed when some are unselected", () => {
    const items = [person("a@x.test"), person("b@x.test")];
    expect([...selectAllVisible(new Set(["a@x.test"]), items)].sort()).toStrictEqual([
      "a@x.test",
      "b@x.test",
    ]);
  });

  it("unselects everything listed when they all already are", () => {
    const items = [person("a@x.test"), person("b@x.test")];
    expect([...selectAllVisible(new Set(["a@x.test", "b@x.test"]), items)]).toStrictEqual([]);
  });

  // The list is search-filtered, so "all visible" must not touch a person the
  // user selected before typing in the search box.
  it("leaves a selection that is filtered out of the list alone, both ways", () => {
    const items = [person("a@x.test")];
    expect([...selectAllVisible(new Set(["hidden@x.test"]), items)].sort()).toStrictEqual([
      "a@x.test",
      "hidden@x.test",
    ]);
    expect([...selectAllVisible(new Set(["a@x.test", "hidden@x.test"]), items)]).toStrictEqual([
      "hidden@x.test",
    ]);
  });

  it("is a no-op on an empty list", () => {
    expect([...selectAllVisible(new Set(["a@x.test"]), [])]).toStrictEqual(["a@x.test"]);
  });

  it("does not mutate the previous selection", () => {
    const before = new Set(["a@x.test"]);
    expect(selectAllVisible(before, [person("b@x.test")])).not.toBe(before);
    expect([...before]).toStrictEqual(["a@x.test"]);
  });
});

describe("pickedPeople", () => {
  it("resolves the selection back to rows so names travel with the addresses", () => {
    const source = [person("a@x.test", "Ada"), person("b@x.test", "Bo"), person("c@x.test")];
    expect(pickedPeople(source, new Set(["a@x.test", "c@x.test"]))).toStrictEqual([
      { email: "a@x.test", name: "Ada" },
      { email: "c@x.test", name: null },
    ]);
  });

  it("keeps the source list's order, not the order things were selected in", () => {
    const source = [person("a@x.test"), person("b@x.test")];
    const selected = new Set<string>();
    selected.add("b@x.test");
    selected.add("a@x.test");
    expect(pickedPeople(source, selected).map((p) => p.email)).toStrictEqual([
      "a@x.test",
      "b@x.test",
    ]);
  });

  it("drops a selection that is no longer in the loaded list", () => {
    expect(pickedPeople([person("a@x.test")], new Set(["gone@x.test"]))).toStrictEqual([]);
  });

  it("carries only the email and name, not the list's own metadata", () => {
    const source = [{ email: "a@x.test", name: "Ada", count: 12, lastReceivedAt: "2026-01-01" }];
    expect(pickedPeople(source, new Set(["a@x.test"]))).toStrictEqual([
      { email: "a@x.test", name: "Ada" },
    ]);
  });
});
