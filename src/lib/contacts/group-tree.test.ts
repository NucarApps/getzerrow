import { describe, expect, it } from "vitest";
import { buildDescendantsById, buildGroupTree, eligibleParents } from "./group-tree";

type G = { id: string; name: string; parent_group_id?: string | null };

const TREE: G[] = [
  { id: "f", name: "Factory", parent_group_id: null },
  { id: "n", name: "Nissan", parent_group_id: "f" },
  { id: "h", name: "Honda", parent_group_id: "f" },
  { id: "v", name: "Vendor", parent_group_id: null },
  { id: "s", name: "Software", parent_group_id: "v" },
  { id: "s2", name: "CRM", parent_group_id: "s" },
  { id: "d", name: "Dealers", parent_group_id: null },
];

describe("buildGroupTree", () => {
  it("walks pre-order with depths, siblings sorted by name", () => {
    const out = buildGroupTree(TREE).map((r) => `${r.depth}:${r.group.id}`);
    expect(out).toEqual(["0:d", "0:f", "1:h", "1:n", "0:v", "1:s", "2:s2"]);
  });

  it("survives cyclic/malformed parent data", () => {
    const cyclic: G[] = [
      { id: "a", name: "A", parent_group_id: "b" },
      { id: "b", name: "B", parent_group_id: "a" },
      { id: "c", name: "C", parent_group_id: null },
    ];
    const out = buildGroupTree(cyclic);
    // Cycle members have no root path, so only the well-formed row appears.
    expect(out.map((r) => r.group.id)).toEqual(["c"]);
  });
});

describe("buildDescendantsById", () => {
  it("includes the group itself and all descendants", () => {
    const m = buildDescendantsById(TREE);
    expect([...m.get("v")!].sort()).toEqual(["s", "s2", "v"]);
    expect([...m.get("f")!].sort()).toEqual(["f", "h", "n"]);
    expect([...m.get("d")!]).toEqual(["d"]);
  });
});

describe("eligibleParents", () => {
  it("excludes self and descendants when editing", () => {
    const ids = eligibleParents(TREE, "v").map((g) => g.id);
    expect(ids).not.toContain("v");
    expect(ids).not.toContain("s");
    expect(ids).not.toContain("s2");
    expect(ids).toContain("f");
    expect(ids).toContain("d");
  });

  it("excludes parents already at max depth", () => {
    // With maxDepth 3, "s2" (depth 3) can't take children; "s" (depth 2) can.
    const ids = eligibleParents(TREE, "d", 3).map((g) => g.id);
    expect(ids).toContain("s");
    expect(ids).not.toContain("s2");
  });

  it("returns all non-max-depth groups in create mode", () => {
    const ids = eligibleParents(TREE, null).map((g) => g.id);
    expect(ids.sort()).toEqual(["d", "f", "h", "n", "s", "s2", "v"]);
  });
});
