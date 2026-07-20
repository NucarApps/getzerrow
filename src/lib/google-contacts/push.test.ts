import { describe, expect, it } from "vitest";
import {
  MY_CONTACTS_RESOURCE,
  formatGoogleLabelName,
  withMyContacts,
} from "./push.server";

describe("formatGoogleLabelName", () => {
  const parentNames = new Map<string, string>([
    ["parent-1", "Factory"],
    ["parent-2", "Vendor"],
  ]);

  it("returns the bare name for top-level groups", () => {
    expect(formatGoogleLabelName("Factory", null, parentNames)).toBe("Factory");
  });

  it("prefixes with parent name when nested", () => {
    expect(formatGoogleLabelName("VW", "parent-1", parentNames)).toBe("Factory - VW");
    expect(formatGoogleLabelName("Software", "parent-2", parentNames)).toBe("Vendor - Software");
  });

  it("falls back to leaf name when parent is missing from map", () => {
    expect(formatGoogleLabelName("Ghost", "unknown", parentNames)).toBe("Ghost");
  });

  it("does not double-prefix when the name already carries the parent", () => {
    expect(formatGoogleLabelName("Factory - VW", "parent-1", parentNames)).toBe("Factory - VW");
  });
});

describe("withMyContacts", () => {
  it("appends the myContacts system group", () => {
    expect(withMyContacts(["contactGroups/abc"])).toEqual([
      "contactGroups/abc",
      MY_CONTACTS_RESOURCE,
    ]);
  });

  it("does not duplicate when already present", () => {
    const input = ["contactGroups/abc", MY_CONTACTS_RESOURCE];
    expect(withMyContacts(input)).toEqual(input);
  });

  it("works for empty memberships", () => {
    expect(withMyContacts([])).toEqual([MY_CONTACTS_RESOURCE]);
  });
});
