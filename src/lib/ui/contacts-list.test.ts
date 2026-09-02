import { describe, expect, it } from "vitest";
import {
  allBucketsCollapsed,
  allowedGroupIdsFor,
  buildContactGroupMap,
  contactInitial,
  countUngrouped,
  filterContacts,
  matchesContactQuery,
  toggleAllBuckets,
  toggleId,
  toggleIds,
  type FilterableContact,
} from "./contacts-list";

const CONTACTS: FilterableContact[] = [
  { id: "c1", name: "Dana Reeves", email: "dana@acme.test", company: "Acme" },
  { id: "c2", name: "Sam Ortiz", email: "sam@globex.test", company: "Globex" },
  { id: "c3", name: null, email: "ops@acme.test", company: null },
  { id: "c4", name: "Lee", email: null, company: null },
];

// c1 and c2 are in groups; c3 and c4 are in none.
const GROUP_MAP = buildContactGroupMap([
  { contact_id: "c1", group_id: "g-sales" },
  { contact_id: "c1", group_id: "g-vip" },
  { contact_id: "c2", group_id: "g-eng" },
]);

// g-sales has g-sales-emea under it.
const DESCENDANTS = new Map([
  ["g-sales", new Set(["g-sales", "g-sales-emea"])],
  ["g-eng", new Set(["g-eng"])],
]);

function ids(contacts: readonly FilterableContact[]): string[] {
  return contacts.map((c) => c.id);
}

describe("buildContactGroupMap", () => {
  it("collects every group a contact belongs to", () => {
    expect(GROUP_MAP.get("c1")).toStrictEqual(["g-sales", "g-vip"]);
  });

  it("omits contacts with no membership rather than storing an empty array", () => {
    expect(GROUP_MAP.has("c3")).toBe(false);
  });

  it("handles an empty membership table", () => {
    expect(buildContactGroupMap([]).size).toBe(0);
  });
});

describe("allowedGroupIdsFor", () => {
  it.each(["all", "ungrouped"])("does not constrain by group for %s", (filter) => {
    expect(allowedGroupIdsFor(filter, DESCENDANTS)).toBeNull();
  });

  it("admits the whole subtree under the selected group", () => {
    expect(allowedGroupIdsFor("g-sales", DESCENDANTS)).toStrictEqual(
      new Set(["g-sales", "g-sales-emea"]),
    );
  });

  it("falls back to the group alone when the tree index has not caught up", () => {
    // Filtering to just that group beats filtering to nothing, which would
    // render the group as empty right after it was created.
    expect(allowedGroupIdsFor("g-brand-new", DESCENDANTS)).toStrictEqual(new Set(["g-brand-new"]));
  });
});

describe("matchesContactQuery", () => {
  const dana = CONTACTS[0]!;

  it("admits everything for an empty term", () => {
    expect(matchesContactQuery({ id: "x" }, "")).toBe(true);
  });

  it.each([
    ["the name", "reeves"],
    ["the email", "acme.test"],
    ["the company", "acme"],
  ])("matches on %s", (_label, term) => {
    expect(matchesContactQuery(dana, term)).toBe(true);
  });

  it("does not match an unrelated term", () => {
    expect(matchesContactQuery(dana, "globex")).toBe(false);
  });

  it("tolerates a contact with every searchable field missing", () => {
    expect(matchesContactQuery({ id: "x" }, "dana")).toBe(false);
  });
});

describe("filterContacts", () => {
  function run(over: Partial<Parameters<typeof filterContacts>[0]> = {}) {
    return filterContacts({
      contacts: CONTACTS,
      query: "",
      filter: "all",
      contactGroupMap: GROUP_MAP,
      descendantsById: DESCENDANTS,
      ...over,
    });
  }

  it("shows everyone under the 'all' filter", () => {
    expect(ids(run())).toStrictEqual(["c1", "c2", "c3", "c4"]);
  });

  it("preserves the server's ordering", () => {
    // Re-sorting here would make the list jump around as the user types.
    expect(ids(run({ query: "e" }))).toStrictEqual(["c1", "c2", "c3", "c4"]);
  });

  it("shows only contacts in no group at all under 'ungrouped'", () => {
    expect(ids(run({ filter: "ungrouped" }))).toStrictEqual(["c3", "c4"]);
  });

  it("shows a group's members", () => {
    expect(ids(run({ filter: "g-eng" }))).toStrictEqual(["c2"]);
  });

  it("includes members of a child group when the parent is selected", () => {
    const map = buildContactGroupMap([{ contact_id: "c4", group_id: "g-sales-emea" }]);
    expect(ids(run({ filter: "g-sales", contactGroupMap: map }))).toStrictEqual(["c4"]);
  });

  it("composes the group filter with the search term", () => {
    const map = buildContactGroupMap([
      { contact_id: "c1", group_id: "g-sales" },
      { contact_id: "c2", group_id: "g-sales" },
    ]);
    expect(ids(run({ filter: "g-sales", contactGroupMap: map, query: "globex" }))).toStrictEqual([
      "c2",
    ]);
  });

  it("ignores surrounding whitespace and case in the search term", () => {
    expect(ids(run({ query: "  DANA  " }))).toStrictEqual(["c1"]);
  });

  it("returns nothing for a term nobody matches", () => {
    expect(run({ query: "nobody" })).toStrictEqual([]);
  });

  it("returns nothing for an empty address book", () => {
    expect(run({ contacts: [] })).toStrictEqual([]);
  });
});

describe("countUngrouped", () => {
  it("counts the contacts belonging to no group", () => {
    expect(countUngrouped(CONTACTS, GROUP_MAP)).toBe(2);
  });

  it("counts everyone when there are no memberships at all", () => {
    expect(countUngrouped(CONTACTS, new Map())).toBe(4);
  });

  it("counts nobody in an empty address book", () => {
    expect(countUngrouped([], GROUP_MAP)).toBe(0);
  });
});

describe("toggleId", () => {
  it("adds an id that was not selected", () => {
    expect(toggleId(new Set(["a"]), "b")).toStrictEqual(new Set(["a", "b"]));
  });

  it("removes an id that was", () => {
    expect(toggleId(new Set(["a", "b"]), "b")).toStrictEqual(new Set(["a"]));
  });

  it("does not mutate the set it was given", () => {
    const before = new Set(["a"]);
    toggleId(before, "b");
    expect(before).toStrictEqual(new Set(["a"]));
  });
});

describe("toggleIds", () => {
  it("selects the whole section when only part of it was selected", () => {
    expect(toggleIds(new Set(["a"]), ["a", "b", "c"])).toStrictEqual(new Set(["a", "b", "c"]));
  });

  it("selects the whole section when none of it was", () => {
    expect(toggleIds(new Set(), ["a", "b"])).toStrictEqual(new Set(["a", "b"]));
  });

  it("clears the section once every member is selected", () => {
    expect(toggleIds(new Set(["a", "b"]), ["a", "b"])).toStrictEqual(new Set());
  });

  it("leaves selections outside the section alone", () => {
    // Judged against the ids passed in, not the whole selection, so ticking
    // one section never disturbs another.
    expect(toggleIds(new Set(["a", "z"]), ["a"])).toStrictEqual(new Set(["z"]));
  });

  it("does nothing for an empty section", () => {
    // Without the length guard `[].every` would report "all selected" and the
    // branch would fall through to a clear.
    expect(toggleIds(new Set(["a"]), [])).toStrictEqual(new Set(["a"]));
  });
});

describe("allBucketsCollapsed", () => {
  const buckets = [{ key: "acme.test" }, { key: "globex.test" }];

  it("is true only when every section is collapsed", () => {
    expect(allBucketsCollapsed(buckets, new Set(["acme.test", "globex.test"]))).toBe(true);
  });

  it("is false while one section is still open", () => {
    expect(allBucketsCollapsed(buckets, new Set(["acme.test"]))).toBe(false);
  });

  it("is false with no sections at all", () => {
    // The button then reads as Collapse all: there is nothing to expand.
    expect(allBucketsCollapsed([], new Set())).toBe(false);
  });

  it("ignores collapsed keys for sections that no longer exist", () => {
    expect(allBucketsCollapsed(buckets, new Set(["acme.test", "gone.test"]))).toBe(false);
  });
});

describe("toggleAllBuckets", () => {
  const buckets = [{ key: "acme.test" }, { key: "globex.test" }];

  it("collapses everything when something is open", () => {
    expect(toggleAllBuckets(buckets, new Set(["acme.test"]))).toStrictEqual(
      new Set(["acme.test", "globex.test"]),
    );
  });

  it("expands everything when all are collapsed", () => {
    expect(toggleAllBuckets(buckets, new Set(["acme.test", "globex.test"]))).toStrictEqual(
      new Set(),
    );
  });

  it("drops stale keys for sections that no longer exist", () => {
    expect(toggleAllBuckets(buckets, new Set(["gone.test"]))).toStrictEqual(
      new Set(["acme.test", "globex.test"]),
    );
  });
});

describe("contactInitial", () => {
  it.each([
    ["a name", { name: "Dana", email: "d@acme.test" }, "D"],
    ["the email when there is no name", { name: null, email: "ops@acme.test" }, "O"],
    ["a fallback when there is neither", { name: null, email: null }, "?"],
    ["a leading space trimmed away", { name: "  Dana" }, "D"],
    ["a digit", { name: "3M" }, "3"],
  ])("derives %s", (_label, contact, expected) => {
    expect(contactInitial(contact)).toBe(expected);
  });

  it("falls back to '?' for a name that is only whitespace", () => {
    // The name is truthy so it wins the `||`, then trims to nothing — the
    // trailing `|| "?"` is what keeps the avatar from rendering blank.
    expect(contactInitial({ name: "   ", email: "ops@acme.test" })).toBe("?");
  });
});
