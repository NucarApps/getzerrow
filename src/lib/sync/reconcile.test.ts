// Unit tests for reconcileLocalInbox — the drift-repair safety net that
// re-syncs local rows against Gmail's canonical state. Contracts:
//
//   * broken rows (missing from/body/received_at) get a full re-fetch +
//     encrypted patch; a re-fetch that lands in TRASH deletes instead,
//   * a 404 on re-fetch means the message is gone → delete, NOT a failure,
//   * healthy rows get cheap label-only mirroring: archive when INBOX is
//     gone, read-state from UNREAD, delete on TRASH/missing,
//   * the tail cursor advances to the oldest row just walked and wraps
//     around (resets to null) when it runs out of older rows,
//   * limit ≤ 60 keeps everything in the head window (no tail query, no
//     cursor movement),
//   * one bad row never aborts the sweep (per-row failure isolation),
//   * pass 2 un-archives rows Gmail moved back to the inbox.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

// Property accesses are deferred into method bodies so the hoisted factory
// never touches `fake` before its initializer runs.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

const getMessage = vi.fn();
const getMessageLabels = vi.fn();
const parseMessage = vi.fn();
vi.mock("../gmail.server", () => ({
  getMessage: (accountId: string, id: string) => getMessage(accountId, id),
  getMessageLabels: (accountId: string, id: string) => getMessageLabels(accountId, id),
  parseMessage: (raw: unknown) => parseMessage(raw),
}));

const logError = vi.fn();
vi.mock("../log.server", () => ({
  logError: (...args: unknown[]) => logError(...args),
  logInfo: () => {},
}));

const updateEmailEncrypted = vi.fn();
vi.mock("./encrypted-writer", () => ({
  updateEmailEncrypted: (input: unknown) => updateEmailEncrypted(input),
}));

import { reconcileLocalInbox } from "./reconcile";

const ACC = "acc-1";

/** Healthy unarchived row — passes the needsRepair probe. */
function emailRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    gmail_message_id: `gm-${id}`,
    gmail_account_id: ACC,
    raw_labels: ["INBOX"],
    from_addr: "sender@x.com",
    body_text_enc: "enc-body",
    body_html_enc: null,
    received_at: "2026-07-10T00:00:00Z",
    folder_id: null,
    is_archived: false,
    is_read: true,
    ...overrides,
  };
}

function parsedMessage(overrides: Record<string, unknown> = {}) {
  return {
    from_addr: "repaired@x.com",
    from_name: "Repaired",
    to_addrs: "me@x.com",
    subject: "Repaired subject",
    snippet: "snip",
    body_text: "body",
    body_html: "<p>body</p>",
    received_at: "2026-07-09T00:00:00Z",
    has_attachment: true,
    raw_labels: ["INBOX", "UNREAD"],
    is_read: false,
    ...overrides,
  };
}

function seedAccount(cursor: string | null = null) {
  fake.seed("gmail_accounts", [{ id: ACC, reconcile_cursor: cursor }]);
}

function emailUpdates() {
  return fake.calls.updates.filter((u) => u.table === "emails");
}
function emailDeletes() {
  return fake.calls.deletes.filter((d) => d.table === "emails");
}
function cursorUpdates() {
  return fake.calls.updates.filter((u) => u.table === "gmail_accounts");
}

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  getMessageLabels.mockResolvedValue(["INBOX"]);
  updateEmailEncrypted.mockResolvedValue({ error: null });
});

describe("healthy-row label mirroring (pass 1)", () => {
  it("mirrors read state from UNREAD on an in-inbox row", async () => {
    seedAccount();
    fake.seed("emails", [emailRow("e1", { is_read: true })]);
    getMessageLabels.mockResolvedValue(["INBOX", "UNREAD"]);

    const res = await reconcileLocalInbox(ACC, 10);
    expect(res).toMatchObject({ checked: 1, updated: 1, archived: 0, deleted: 0, failed: 0 });
    expect(emailUpdates()).toHaveLength(1);
    expect(emailUpdates()[0].payload).toEqual({
      raw_labels: ["INBOX", "UNREAD"],
      is_read: false,
    });
    expect(emailUpdates()[0].filters).toEqual([{ op: "eq", col: "id", value: "e1" }]);
  });

  it("archives locally when Gmail no longer shows INBOX", async () => {
    seedAccount();
    fake.seed("emails", [emailRow("e1")]);
    getMessageLabels.mockResolvedValue(["Label_7"]);

    const res = await reconcileLocalInbox(ACC, 10);
    expect(res).toMatchObject({ checked: 1, archived: 1, updated: 0 });
    expect(emailUpdates()[0].payload).toEqual({
      is_archived: true,
      raw_labels: ["Label_7"],
      is_read: true,
    });
  });

  it("deletes the local row when Gmail says TRASH", async () => {
    seedAccount();
    fake.seed("emails", [emailRow("e1")]);
    getMessageLabels.mockResolvedValue(["TRASH"]);

    const res = await reconcileLocalInbox(ACC, 10);
    expect(res).toMatchObject({ checked: 1, deleted: 1, failed: 0 });
    expect(emailDeletes()).toHaveLength(1);
    expect(emailDeletes()[0].filters).toEqual([{ op: "eq", col: "id", value: "e1" }]);
    expect(emailUpdates()).toHaveLength(0);
  });

  it("deletes the local row when the message is gone (labels fetch → null)", async () => {
    seedAccount();
    fake.seed("emails", [emailRow("e1")]);
    getMessageLabels.mockResolvedValue(null);

    const res = await reconcileLocalInbox(ACC, 10);
    expect(res).toMatchObject({ checked: 1, deleted: 1, failed: 0 });
    expect(emailDeletes()).toHaveLength(1);
  });
});

describe("broken-row repair (pass 1)", () => {
  it("re-fetches + patches a row with missing plaintext, without a label-only fetch", async () => {
    seedAccount();
    fake.seed("emails", [emailRow("e1", { from_addr: null })]);
    getMessage.mockResolvedValue({ raw: true });
    parseMessage.mockReturnValue(parsedMessage());

    const res = await reconcileLocalInbox(ACC, 10);
    expect(res).toMatchObject({ checked: 1, repaired: 1, archived: 0, failed: 0 });
    expect(getMessage).toHaveBeenCalledWith(ACC, "gm-e1");
    // Repair short-circuits the label check for this row.
    expect(getMessageLabels).not.toHaveBeenCalled();

    // Sensitive fields go through the encrypted writer...
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: "e1",
      from_name: "Repaired",
      to_addrs: "me@x.com",
      subject: "Repaired subject",
      snippet: "snip",
      body_text: "body",
      body_html: "<p>body</p>",
    });
    // ...and the plaintext columns via a plain update.
    expect(emailUpdates()).toHaveLength(1);
    expect(emailUpdates()[0].payload).toEqual({
      from_addr: "repaired@x.com",
      received_at: "2026-07-09T00:00:00Z",
      has_attachment: true,
      raw_labels: ["INBOX", "UNREAD"],
      is_read: false,
      is_archived: false,
    });
  });

  it("counts a repaired row as archived when the re-fetch shows it left the inbox", async () => {
    seedAccount();
    fake.seed("emails", [emailRow("e1", { body_text_enc: null, body_html_enc: null })]);
    getMessage.mockResolvedValue({ raw: true });
    parseMessage.mockReturnValue(parsedMessage({ raw_labels: ["Label_7"] }));

    const res = await reconcileLocalInbox(ACC, 10);
    expect(res).toMatchObject({ repaired: 1, archived: 1 });
    expect(emailUpdates()[0].payload).toMatchObject({ is_archived: true });
  });

  it("deletes instead of repairing when the re-fetched message is in TRASH", async () => {
    seedAccount();
    fake.seed("emails", [emailRow("e1", { received_at: null })]);
    getMessage.mockResolvedValue({ raw: true });
    parseMessage.mockReturnValue(parsedMessage({ raw_labels: ["TRASH"] }));

    const res = await reconcileLocalInbox(ACC, 10);
    expect(res).toMatchObject({ deleted: 1, repaired: 0, failed: 0 });
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
    expect(emailDeletes()).toHaveLength(1);
  });

  it("treats a 404 on re-fetch as gone → delete, not a failure", async () => {
    seedAccount();
    fake.seed("emails", [emailRow("e1", { from_addr: null })]);
    getMessage.mockRejectedValue(new Error("Gmail API error 404: Not Found"));

    const res = await reconcileLocalInbox(ACC, 10);
    expect(res).toMatchObject({ deleted: 1, failed: 0, repaired: 0 });
    expect(emailDeletes()).toHaveLength(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it("isolates a non-404 repair failure to that row and keeps sweeping", async () => {
    seedAccount();
    fake.seed("emails", [
      emailRow("e1", { from_addr: null, received_at: "2026-07-11T00:00:00Z" }),
      emailRow("e2", { received_at: "2026-07-10T00:00:00Z", is_read: false }),
    ]);
    getMessage.mockRejectedValue(new Error("Gmail API error 500: boom"));
    getMessageLabels.mockResolvedValue(["INBOX"]);

    const res = await reconcileLocalInbox(ACC, 10);
    expect(res).toMatchObject({ checked: 2, failed: 1, updated: 1 });
    expect(logError).toHaveBeenCalledWith(
      "reconcile.row_failed",
      expect.objectContaining({ email_id: "e1", pass: "head_tail" }),
      expect.any(Error),
    );
    // The healthy second row was still mirrored.
    expect(emailUpdates()).toHaveLength(1);
    expect(emailUpdates()[0].filters).toEqual([{ op: "eq", col: "id", value: "e2" }]);
  });
});

describe("cursor walk", () => {
  it("keeps everything in the head window when limit ≤ 60 (no tail query, cursor untouched)", async () => {
    seedAccount("2026-07-05T00:00:00Z");
    fake.seed("emails", [emailRow("e1")]);

    await reconcileLocalInbox(ACC, 10);
    // Exactly one unarchived (pass-1) select — head only.
    const unarchivedSelects = fake.calls.selects.filter(
      (s) =>
        s.table === "emails" &&
        s.filters.some((f) => f.op === "eq" && f.col === "is_archived" && f.value === false),
    );
    expect(unarchivedSelects).toHaveLength(1);
    expect(cursorUpdates()).toHaveLength(0);
  });

  it("anchors the tail at the stored cursor and advances it to the oldest row touched", async () => {
    seedAccount("2026-07-08T00:00:00Z");
    fake.seed("emails", [
      emailRow("e-new", { received_at: "2026-07-10T00:00:00Z" }),
      emailRow("e-old1", { received_at: "2026-07-05T00:00:00Z" }),
      emailRow("e-old2", { received_at: "2026-07-03T00:00:00Z" }),
    ]);

    await reconcileLocalInbox(ACC, 100);
    // Tail select carries lt(received_at, cursor).
    const tailSelect = fake.calls.selects.find(
      (s) =>
        s.table === "emails" && s.filters.some((f) => f.op === "lt" && f.col === "received_at"),
    );
    expect(tailSelect?.filters).toContainEqual({
      op: "lt",
      col: "received_at",
      value: "2026-07-08T00:00:00Z",
    });
    expect(cursorUpdates()).toHaveLength(1);
    expect(cursorUpdates()[0].payload).toEqual({ reconcile_cursor: "2026-07-03T00:00:00Z" });
  });

  it("falls back to the head's oldest received_at as tail anchor when cursor is null", async () => {
    seedAccount(null);
    fake.seed("emails", [
      emailRow("e1", { received_at: "2026-07-10T00:00:00Z" }),
      emailRow("e2", { received_at: "2026-07-06T00:00:00Z" }),
    ]);

    await reconcileLocalInbox(ACC, 100);
    const tailSelect = fake.calls.selects.find(
      (s) =>
        s.table === "emails" && s.filters.some((f) => f.op === "lt" && f.col === "received_at"),
    );
    expect(tailSelect?.filters).toContainEqual({
      op: "lt",
      col: "received_at",
      value: "2026-07-06T00:00:00Z",
    });
    // No tail rows older than the head → nothing to advance to, cursor stays null.
    expect(cursorUpdates()).toHaveLength(0);
  });

  it("wraps around: cursor resets to null when no rows remain older than it", async () => {
    seedAccount("2026-01-01T00:00:00Z");
    fake.seed("emails", [emailRow("e1", { received_at: "2026-07-10T00:00:00Z" })]);

    await reconcileLocalInbox(ACC, 100);
    expect(cursorUpdates()).toHaveLength(1);
    expect(cursorUpdates()[0].payload).toEqual({ reconcile_cursor: null });
  });
});

describe("archived pass (pass 2)", () => {
  it("un-archives and un-reads a row Gmail moved back to the inbox", async () => {
    seedAccount();
    fake.seed("emails", [emailRow("a1", { is_archived: true, is_read: true })]);
    getMessageLabels.mockResolvedValue(["INBOX", "UNREAD"]);

    const res = await reconcileLocalInbox(ACC, 10);
    expect(res).toMatchObject({ archived_checked: 1, unarchived: 1, checked: 0 });
    expect(emailUpdates()).toHaveLength(1);
    expect(emailUpdates()[0].payload).toEqual({
      raw_labels: ["INBOX", "UNREAD"],
      is_archived: false,
      is_read: false,
    });
  });

  it("only patches read state when it actually changed, and deletes trashed archived rows", async () => {
    seedAccount();
    fake.seed("emails", [
      emailRow("a1", { is_archived: true, is_read: true, received_at: "2026-07-10T00:00:00Z" }),
      emailRow("a2", { is_archived: true, is_read: true, received_at: "2026-07-09T00:00:00Z" }),
    ]);
    getMessageLabels.mockImplementation(async (_acc: string, gmailId: string) =>
      gmailId === "gm-a1" ? ["Label_7"] : ["TRASH"],
    );

    const res = await reconcileLocalInbox(ACC, 10);
    expect(res).toMatchObject({ archived_checked: 2, unarchived: 0, deleted: 1 });
    // a1: still archived + already read → raw_labels-only patch.
    expect(emailUpdates()).toHaveLength(1);
    expect(emailUpdates()[0].payload).toEqual({ raw_labels: ["Label_7"] });
    // a2: trashed in Gmail → local delete.
    expect(emailDeletes()).toHaveLength(1);
    expect(emailDeletes()[0].filters).toEqual([{ op: "eq", col: "id", value: "a2" }]);
  });

  it("isolates a pass-2 failure per row", async () => {
    seedAccount();
    fake.seed("emails", [
      emailRow("a1", { is_archived: true, received_at: "2026-07-10T00:00:00Z" }),
      emailRow("a2", { is_archived: true, is_read: false, received_at: "2026-07-09T00:00:00Z" }),
    ]);
    getMessageLabels.mockImplementation(async (_acc: string, gmailId: string) => {
      if (gmailId === "gm-a1") throw new Error("Gmail API error 500");
      return ["INBOX"];
    });

    const res = await reconcileLocalInbox(ACC, 10);
    expect(res).toMatchObject({ failed: 1, unarchived: 1 });
    expect(logError).toHaveBeenCalledWith(
      "reconcile.row_failed",
      expect.objectContaining({ email_id: "a1", pass: "archived" }),
      expect.any(Error),
    );
    expect(emailUpdates()).toHaveLength(1);
    expect(emailUpdates()[0].filters).toEqual([{ op: "eq", col: "id", value: "a2" }]);
  });
});
