import { describe, expect, it } from "vitest";
import { resolveAutoMarkRead, rulesForFolder, type MarkReadRule } from "./mark-read-scope";

const folderId = "f1";
const rules: MarkReadRule[] = [
  { folder_id: folderId, match_type: "email", value: "jared@kenect.com" },
  { folder_id: folderId, match_type: "domain", value: "nucar.com" },
  { folder_id: "other", match_type: "domain", value: "example.com" },
];

const mine = rulesForFolder(rules, folderId);

describe("resolveAutoMarkRead", () => {
  it("returns false when the folder flag is off", () => {
    expect(
      resolveAutoMarkRead({ auto_mark_read: false, mark_read_mode: "all" }, mine, {
        from_addr: "a@b.com",
      }),
    ).toBe(false);
  });

  it("marks everything read in 'all' mode", () => {
    expect(
      resolveAutoMarkRead({ auto_mark_read: true, mark_read_mode: "all" }, mine, {
        from_addr: "jared@kenect.com",
      }),
    ).toBe(true);
  });

  it("defaults to 'all' when the mode is missing", () => {
    expect(resolveAutoMarkRead({ auto_mark_read: true }, mine, { from_addr: "a@b.com" })).toBe(true);
  });

  it("keeps listed addresses unread in 'except' mode", () => {
    const folder = { auto_mark_read: true, mark_read_mode: "except" };
    expect(resolveAutoMarkRead(folder, mine, { from_addr: "jared@kenect.com" })).toBe(false);
    expect(resolveAutoMarkRead(folder, mine, { from_addr: "sean@kenect.com" })).toBe(true);
  });

  it("matches domains and subdomains", () => {
    const folder = { auto_mark_read: true, mark_read_mode: "except" };
    expect(resolveAutoMarkRead(folder, mine, { from_addr: "kc@nucar.com" })).toBe(false);
    expect(resolveAutoMarkRead(folder, mine, { from_addr: "kc@mail.nucar.com" })).toBe(false);
    expect(resolveAutoMarkRead(folder, mine, { from_addr: "kc@notnucar.com" })).toBe(true);
  });

  it("marks only listed senders read in 'only' mode", () => {
    const folder = { auto_mark_read: true, mark_read_mode: "only" };
    expect(resolveAutoMarkRead(folder, mine, { from_addr: "kc@nucar.com" })).toBe(true);
    expect(resolveAutoMarkRead(folder, mine, { from_addr: "someone@else.com" })).toBe(false);
  });

  it("judges forwarded mail by the original sender", () => {
    const forwarded = { from_addr: "kconnor@nucar.com", origin_addr: "jared@kenect.com" };
    expect(
      resolveAutoMarkRead({ auto_mark_read: true, mark_read_mode: "except" }, mine, forwarded),
    ).toBe(false);
    expect(
      resolveAutoMarkRead({ auto_mark_read: true, mark_read_mode: "only" }, mine, forwarded),
    ).toBe(true);
  });

  it("handles empty lists at both extremes", () => {
    const sender = { from_addr: "a@b.com" };
    expect(resolveAutoMarkRead({ auto_mark_read: true, mark_read_mode: "except" }, [], sender)).toBe(
      true,
    );
    expect(resolveAutoMarkRead({ auto_mark_read: true, mark_read_mode: "only" }, [], sender)).toBe(
      false,
    );
  });

  it("ignores rules belonging to other folders", () => {
    expect(
      resolveAutoMarkRead({ auto_mark_read: true, mark_read_mode: "except" }, mine, {
        from_addr: "x@example.com",
      }),
    ).toBe(true);
  });

  it("accepts a bare sender string and unknown senders", () => {
    const folder = { auto_mark_read: true, mark_read_mode: "except" };
    expect(resolveAutoMarkRead(folder, mine, "JARED@KENECT.COM")).toBe(false);
    expect(resolveAutoMarkRead(folder, mine, null)).toBe(true);
  });
});
