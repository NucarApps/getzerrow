// rowBelongsInList is the gate that prevents the realtime hook from
// inserting newly-arrived rows into the wrong cached query (e.g. a folder=A
// row appearing in a folder=B list). The contract has to stay in sync with
// the query keys inbox.tsx uses — these tests pin that contract.
import { describe, it, expect } from "vitest";
import { rowBelongsInList, type EmailRow } from "./use-email-realtime";

const ACC = "acc-1";

function row(over: Partial<EmailRow> = {}): EmailRow {
  return {
    id: over.id ?? "row-1",
    user_id: over.user_id ?? "user-1",
    gmail_message_id: over.gmail_message_id ?? "msg-1",
    received_at: over.received_at ?? new Date().toISOString(),
    is_archived: over.is_archived ?? false,
    folder_id: over.folder_id ?? null,
    gmail_account_id: "gmail_account_id" in over ? over.gmail_account_id : ACC,
    raw_labels: "raw_labels" in over ? over.raw_labels : ["INBOX"],
  };
}

describe("rowBelongsInList", () => {
  it("the top-level ['emails'] list accepts any row", () => {
    expect(rowBelongsInList(row(), ["emails"])).toBe(true);
    expect(rowBelongsInList(row({ is_archived: true, folder_id: "f-1" }), ["emails"])).toBe(true);
  });

  it("['emails', accountId] (no scope) accepts any row for that account", () => {
    expect(rowBelongsInList(row(), ["emails", ACC])).toBe(true);
    expect(rowBelongsInList(row({ gmail_account_id: "other" }), ["emails", ACC])).toBe(false);
  });

  it("['emails', accountId, 'all'] accepts only unarchived rows whose raw_labels include INBOX", () => {
    expect(rowBelongsInList(row({ raw_labels: ["INBOX"] }), ["emails", ACC, "all"])).toBe(true);
    expect(rowBelongsInList(row({ raw_labels: ["INBOX", "Label_123"], folder_id: "f-1" }), ["emails", ACC, "all"])).toBe(true);
    expect(rowBelongsInList(row({ raw_labels: ["INBOX"], is_archived: true }), ["emails", ACC, "all"])).toBe(false);
    expect(rowBelongsInList(row({ raw_labels: ["Label_123"] }), ["emails", ACC, "all"])).toBe(false);
    expect(rowBelongsInList(row({ raw_labels: [] }), ["emails", ACC, "all"])).toBe(false);
    expect(rowBelongsInList(row({ raw_labels: null }), ["emails", ACC, "all"])).toBe(false);
  });

  it("['emails', accountId, 'all_mail'] accepts everything for that account", () => {
    expect(rowBelongsInList(row({ raw_labels: [], is_archived: true, folder_id: "f-1" }), ["emails", ACC, "all_mail"])).toBe(true);
    expect(rowBelongsInList(row({ gmail_account_id: "other" }), ["emails", ACC, "all_mail"])).toBe(false);
  });

  it("['emails', accountId, 'archived'] accepts ONLY archived rows", () => {
    expect(rowBelongsInList(row({ is_archived: true }), ["emails", ACC, "archived"])).toBe(true);
    expect(rowBelongsInList(row({ is_archived: false }), ["emails", ACC, "archived"])).toBe(false);
  });

  it("['emails', accountId, 'no_rules'] requires folder_id null and no user labels", () => {
    expect(rowBelongsInList(row({ folder_id: null, raw_labels: ["INBOX"] }), ["emails", ACC, "no_rules"])).toBe(true);
    expect(rowBelongsInList(row({ folder_id: "f-1", raw_labels: ["INBOX"] }), ["emails", ACC, "no_rules"])).toBe(false);
    expect(rowBelongsInList(row({ folder_id: null, raw_labels: ["INBOX", "Label_5"] }), ["emails", ACC, "no_rules"])).toBe(false);
  });

  it("['emails', accountId, <folder-id>] accepts ONLY rows whose folder_id matches", () => {
    expect(rowBelongsInList(row({ folder_id: "f-abc" }), ["emails", ACC, "f-abc"])).toBe(true);
    expect(rowBelongsInList(row({ folder_id: "f-xyz" }), ["emails", ACC, "f-abc"])).toBe(false);
    expect(rowBelongsInList(row({ folder_id: null }), ["emails", ACC, "f-abc"])).toBe(false);
  });

  it("search query keys reject realtime inserts/updates", () => {
    const key = ["emails", ACC, "all", "search:foo bar"];
    expect(rowBelongsInList(row({ raw_labels: ["INBOX"] }), key)).toBe(false);
  });

  it("pagination query keys still accept matching rows", () => {
    const key = ["emails", ACC, "all", "page:0:start"];
    expect(rowBelongsInList(row({ raw_labels: ["INBOX"] }), key)).toBe(true);
  });

  it("legacy ['emails', '<scope>'] keys still work when accountId not present in row", () => {
    expect(rowBelongsInList(row({ gmail_account_id: null, raw_labels: ["INBOX"] }), ["emails", "all"])).toBe(true);
    expect(rowBelongsInList(row({ gmail_account_id: null, is_archived: true }), ["emails", "archived"])).toBe(true);
  });

  it("rejects unknown non-string tags at [1]", () => {
    expect(rowBelongsInList(row(), ["emails", 42])).toBe(false);
    expect(rowBelongsInList(row(), ["emails", { folderId: "f" }])).toBe(false);
  });
});
