import { describe, expect, it } from "vitest";
import { formatGroupDisplayName, type GroupNameNode } from "./group-name";

const byId = new Map<string, GroupNameNode>([
  ["f", { name: "Factory", parent: null }],
  ["n", { name: "Nissan", parent: "f" }],
  ["s2", { name: "CRM", parent: "s" }],
  ["s", { name: "Software", parent: "v" }],
  ["v", { name: "Vendor", parent: null }],
  ["orphan", { name: "Orphan", parent: "missing" }],
]);

describe("formatGroupDisplayName", () => {
  it("leaf style returns the own name untouched", () => {
    expect(formatGroupDisplayName(byId, "n", "Nissan", "leaf")).toBe("Nissan");
  });

  it("path_slash joins the ancestor chain", () => {
    expect(formatGroupDisplayName(byId, "n", "Nissan", "path_slash")).toBe("Factory / Nissan");
    expect(formatGroupDisplayName(byId, "s2", "CRM", "path_slash")).toBe("Vendor / Software / CRM");
  });

  it("path_dash uses the dash separator", () => {
    expect(formatGroupDisplayName(byId, "n", "Nissan", "path_dash")).toBe("Factory - Nissan");
  });

  it("single-level groups keep their own name in path styles", () => {
    expect(formatGroupDisplayName(byId, "f", "Factory", "path_slash")).toBe("Factory");
  });

  it("stops at a missing parent and unknown groups fall back to ownName", () => {
    expect(formatGroupDisplayName(byId, "orphan", "Orphan", "path_slash")).toBe("Orphan");
    expect(formatGroupDisplayName(byId, "nope", "Fallback", "path_slash")).toBe("Fallback");
  });
});
