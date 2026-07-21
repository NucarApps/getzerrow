import { describe, expect, it } from "vitest";
import { MY_CONTACTS_RESOURCE, chunk, formatGoogleLabelName, withMyContacts } from "./push.server";
import { buildContactGroupUpdateBody, getContactGroupMemberQuery } from "./people-client.server";

describe("chunk", () => {
  it("splits into fixed-size groups preserving order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("returns [] for empty input", () => {
    expect(chunk<number>([], 5)).toEqual([]);
  });
  it("returns a single chunk for size >= length", () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });
  it("falls back to one chunk for non-positive size", () => {
    expect(chunk([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
  });
});

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

describe("People contact group requests", () => {
  it("builds group rename payloads with resourceName and etag", () => {
    expect(buildContactGroupUpdateBody("contactGroups/abc", "Factory - VW", "group-etag")).toEqual({
      contactGroup: {
        resourceName: "contactGroups/abc",
        etag: "group-etag",
        name: "Factory - VW",
      },
      updateGroupFields: "name",
    });
  });

  it("does not include memberResourceNames in the groupFields mask", () => {
    expect(getContactGroupMemberQuery()).toEqual({
      groupFields: "name,groupType,memberCount",
      maxMembers: "10000",
    });
  });
});
