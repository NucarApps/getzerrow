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

describe("nextMarkReadScope", () => {
  const off = { auto_mark_read: false, mark_read_mode: "all" as const, listed: false };
  const all = { auto_mark_read: true, mark_read_mode: "all" as const, listed: false };
  const except = { auto_mark_read: true, mark_read_mode: "except" as const, listed: true };
  const only = { auto_mark_read: true, mark_read_mode: "only" as const, listed: false };

  it("turns auto mark-read on scoped to just this sender", () => {
    expect(nextMarkReadScope(off, true)).toEqual({
      auto_mark_read: true,
      mark_read_mode: "only",
      listed: true,
    });
  });

  it("leaves a mark-read-off folder untouched when the user wants unread", () => {
    expect(nextMarkReadScope(off, false)).toEqual({
      auto_mark_read: false,
      mark_read_mode: "all",
      listed: false,
    });
  });

  it("keeps 'all' as-is when the user wants mark read", () => {
    expect(nextMarkReadScope(all, true)).toEqual({
      auto_mark_read: true,
      mark_read_mode: "all",
      listed: false,
    });
  });

  it("switches 'all' to 'except' when the user wants unread", () => {
    expect(nextMarkReadScope(all, false)).toEqual({
      auto_mark_read: true,
      mark_read_mode: "except",
      listed: true,
    });
  });

  it("drops the exemption under 'except' when the user wants mark read", () => {
    expect(nextMarkReadScope(except, true)).toEqual({
      auto_mark_read: true,
      mark_read_mode: "except",
      listed: false,
    });
  });

  it("keeps the exemption under 'except' when the user wants unread", () => {
    expect(nextMarkReadScope(except, false)).toEqual({
      auto_mark_read: true,
      mark_read_mode: "except",
      listed: true,
    });
  });

  it("adds the sender under 'only' when the user wants mark read", () => {
    expect(nextMarkReadScope(only, true)).toEqual({
      auto_mark_read: true,
      mark_read_mode: "only",
      listed: true,
    });
  });

  it("removes the sender under 'only' when the user wants unread", () => {
    expect(nextMarkReadScope({ ...only, listed: true }, false)).toEqual({
      auto_mark_read: true,
      mark_read_mode: "only",
      listed: false,
    });
  });

  it("round-trips through resolveAutoMarkRead for each mode", () => {
    for (const start of [off, all, except, only]) {
      for (const choice of [true, false]) {
        const next = nextMarkReadScope(start, choice);
        const rules = next.listed
          ? [{ folder_id: "f", match_type: "email" as const, value: "a@x.com" }]
          : [];
        const applied = resolveAutoMarkRead(next, rules, "a@x.com");
        // "off + leave unread" is the one no-op: nothing to assert beyond it staying off.
        if (!next.auto_mark_read) expect(applied).toBe(false);
        else expect(applied).toBe(choice);
      }
    }
  });
});
