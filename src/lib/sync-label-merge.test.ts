import { describe, it, expect } from "vitest";
import { computeLabelPatch } from "./sync/label-merge";

describe("computeLabelPatch", () => {
  it("strips INBOX from raw_labels when Gmail archives the message", () => {
    const patch = computeLabelPatch(["INBOX", "UNREAD", "CATEGORY_PERSONAL"], [], ["INBOX"]);
    expect(patch.is_archived).toBe(true);
    expect(patch.raw_labels).not.toContain("INBOX");
    expect(patch.raw_labels).toEqual(expect.arrayContaining(["UNREAD", "CATEGORY_PERSONAL"]));
  });

  it("adds INBOX back when Gmail unarchives", () => {
    const patch = computeLabelPatch(["CATEGORY_PERSONAL"], ["INBOX"], []);
    expect(patch.is_archived).toBe(false);
    expect(patch.raw_labels).toContain("INBOX");
  });

  it("marks read when UNREAD removed", () => {
    const patch = computeLabelPatch(["INBOX", "UNREAD"], [], ["UNREAD"]);
    expect(patch.is_read).toBe(true);
    expect(patch.raw_labels).not.toContain("UNREAD");
    expect(patch.raw_labels).toContain("INBOX");
  });

  it("marks unread when UNREAD added", () => {
    const patch = computeLabelPatch(["INBOX"], ["UNREAD"], []);
    expect(patch.is_read).toBe(false);
    expect(patch.raw_labels).toContain("UNREAD");
  });

  it("does not duplicate already-present labels", () => {
    const patch = computeLabelPatch(["INBOX", "STARRED"], ["STARRED"], []);
    expect(patch.raw_labels?.filter((l) => l === "STARRED")).toHaveLength(1);
  });

  it("returns empty patch when no currentLabels and no inbox/unread deltas", () => {
    const patch = computeLabelPatch(undefined, ["Label_123"], []);
    expect(patch).toEqual({});
  });
});
