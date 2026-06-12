// rowBelongsInList is the gate that prevents the realtime hook from
// inserting newly-arrived rows into the wrong cached query (e.g. a folder=A
// row appearing in a folder=B list). The contract has to stay in sync with
// the query keys inbox.tsx uses — these tests pin that contract.
import { describe, it, expect } from "vitest";
import { rowBelongsInList, type EmailRow } from "./use-email-realtime";

function row(over: Partial<EmailRow> = {}): EmailRow {
  return {
    id: over.id ?? "row-1",
    user_id: over.user_id ?? "user-1",
    gmail_message_id: over.gmail_message_id ?? "msg-1",
    received_at: over.received_at ?? new Date().toISOString(),
    is_archived: over.is_archived ?? false,
    folder_id: over.folder_id ?? null,
  };
}

describe("rowBelongsInList", () => {
  it("the top-level ['emails'] list accepts any row", () => {
    expect(rowBelongsInList(row(), ["emails"])).toBe(true);
    expect(rowBelongsInList(row({ is_archived: true, folder_id: "f-1" }), ["emails"])).toBe(true);
  });

  it("['emails', 'all'] accepts any row", () => {
    expect(rowBelongsInList(row({ folder_id: "f-1", is_archived: true }), ["emails", "all"])).toBe(true);
    expect(rowBelongsInList(row({ folder_id: null, is_archived: false }), ["emails", "all"])).toBe(true);
  });

  it("['emails', 'inbox'] accepts ONLY un-archived, unfoldered rows", () => {
    expect(rowBelongsInList(row({ is_archived: false, folder_id: null }), ["emails", "inbox"])).toBe(true);
    expect(rowBelongsInList(row({ is_archived: true, folder_id: null }), ["emails", "inbox"])).toBe(false);
    expect(rowBelongsInList(row({ is_archived: false, folder_id: "f-1" }), ["emails", "inbox"])).toBe(false);
  });

  it("['emails', 'archived'] accepts ONLY archived rows", () => {
    expect(rowBelongsInList(row({ is_archived: true }), ["emails", "archived"])).toBe(true);
    expect(rowBelongsInList(row({ is_archived: false }), ["emails", "archived"])).toBe(false);
    expect(rowBelongsInList(row({ is_archived: null }), ["emails", "archived"])).toBe(false);
  });

  it("['emails', <folder-id>] accepts ONLY rows whose folder_id matches", () => {
    expect(rowBelongsInList(row({ folder_id: "f-abc" }), ["emails", "f-abc"])).toBe(true);
    expect(rowBelongsInList(row({ folder_id: "f-xyz" }), ["emails", "f-abc"])).toBe(false);
    expect(rowBelongsInList(row({ folder_id: null }), ["emails", "f-abc"])).toBe(false);
  });

  it("treats unknown non-string tags as 'don't insert' (safer than guess)", () => {
    expect(rowBelongsInList(row(), ["emails", 42])).toBe(false);
    expect(rowBelongsInList(row(), ["emails", { folderId: "f" }])).toBe(false);
    expect(rowBelongsInList(row(), ["emails", null])).toBe(false);
  });

  it("the special tags don't get confused with folder ids", () => {
    // A folder literally named "inbox" is unusual but possible. The folder
    // id should be a UUID — not "inbox"/"archived"/"all" — so we can keep
    // those as reserved tags without conflict.
    expect(rowBelongsInList(row({ folder_id: "inbox" }), ["emails", "inbox"])).toBe(false);
    // (Caller's responsibility: never use a literal "inbox"/"archived"/"all"
    // as a folder id when constructing query keys.)
  });
});

// The two INSERT shapes process-message now emits. The pending_ai row
// must land in the inbox list (visible while AI sorts it); the
// rules-final row must land straight in its folder (and the archived
// list when the folder auto-archives) — never flash through the inbox.
describe("rowBelongsInList — classification insert shapes", () => {
  it("a pending_ai row (no folder, not archived) belongs in the inbox list", () => {
    const pending = row({ folder_id: null, is_archived: false, classified_by: "pending_ai" });
    expect(rowBelongsInList(pending, ["emails", "inbox"])).toBe(true);
    expect(rowBelongsInList(pending, ["emails", "f-work"])).toBe(false);
  });

  it("a rules-final auto-archived row belongs in its folder + archived lists, NOT the inbox", () => {
    const routed = row({ folder_id: "f-work", is_archived: true, classified_by: "filter" });
    expect(rowBelongsInList(routed, ["emails", "f-work"])).toBe(true);
    expect(rowBelongsInList(routed, ["emails", "archived"])).toBe(true);
    expect(rowBelongsInList(routed, ["emails", "inbox"])).toBe(false);
  });
});
