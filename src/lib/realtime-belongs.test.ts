// rowBelongsInList is the gate that prevents the realtime hook from
// inserting newly-arrived rows into the wrong cached query (e.g. a folder=A
// row appearing in a folder=B list). The contract has to stay in sync with
// the query keys inbox.tsx uses — these tests pin that contract.
import { describe, it, expect } from "vitest";
import {
  rowBelongsInList,
  applyPendingOpsToList,
  isDamagedPayload,
  type EmailRow,
} from "./use-email-realtime";

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
    classified_by: "classified_by" in over ? over.classified_by : null,
    folder: "folder" in over ? over.folder : null,
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

  it("['emails', accountId, 'all'] accepts only actionable unarchived inbox rows", () => {
    expect(rowBelongsInList(row({ raw_labels: ["INBOX"] }), ["emails", ACC, "all"])).toBe(true);
    expect(
      rowBelongsInList(row({ raw_labels: ["INBOX", "Label_123"], folder_id: "f-1" }), [
        "emails",
        ACC,
        "all",
      ]),
    ).toBe(true);
    expect(
      rowBelongsInList(row({ raw_labels: ["INBOX"], is_archived: true }), ["emails", ACC, "all"]),
    ).toBe(false);
    expect(rowBelongsInList(row({ raw_labels: ["Label_123"] }), ["emails", ACC, "all"])).toBe(
      false,
    );
    expect(rowBelongsInList(row({ raw_labels: [] }), ["emails", ACC, "all"])).toBe(false);
    expect(rowBelongsInList(row({ raw_labels: null }), ["emails", ACC, "all"])).toBe(false);
    expect(
      rowBelongsInList(
        row({
          raw_labels: ["INBOX"],
          folder_id: "f-hidden",
          folder: { auto_archive: true, hide_from_inbox: false },
        }),
        ["emails", ACC, "all"],
      ),
    ).toBe(false);
  });

  it("['emails', accountId, 'all_mail'] accepts everything for that account", () => {
    expect(
      rowBelongsInList(row({ raw_labels: [], is_archived: true, folder_id: "f-1" }), [
        "emails",
        ACC,
        "all_mail",
      ]),
    ).toBe(true);
    expect(rowBelongsInList(row({ gmail_account_id: "other" }), ["emails", ACC, "all_mail"])).toBe(
      false,
    );
  });

  it("['emails', accountId, 'archived'] accepts ONLY archived rows", () => {
    expect(rowBelongsInList(row({ is_archived: true }), ["emails", ACC, "archived"])).toBe(true);
    expect(rowBelongsInList(row({ is_archived: false }), ["emails", ACC, "archived"])).toBe(false);
  });

  it("['emails', accountId, 'no_rules'] requires folder_id null and no user labels", () => {
    expect(
      rowBelongsInList(row({ folder_id: null, raw_labels: ["INBOX"] }), [
        "emails",
        ACC,
        "no_rules",
      ]),
    ).toBe(true);
    expect(
      rowBelongsInList(row({ folder_id: "f-1", raw_labels: ["INBOX"] }), [
        "emails",
        ACC,
        "no_rules",
      ]),
    ).toBe(false);
    expect(
      rowBelongsInList(row({ folder_id: null, raw_labels: ["INBOX", "Label_5"] }), [
        "emails",
        ACC,
        "no_rules",
      ]),
    ).toBe(false);
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
    expect(
      rowBelongsInList(row({ gmail_account_id: null, raw_labels: ["INBOX"] }), ["emails", "all"]),
    ).toBe(true);
    expect(
      rowBelongsInList(row({ gmail_account_id: null, is_archived: true }), ["emails", "archived"]),
    ).toBe(true);
  });

  it("rejects unknown non-string tags at [1]", () => {
    expect(rowBelongsInList(row(), ["emails", 42])).toBe(false);
    expect(rowBelongsInList(row(), ["emails", { folderId: "f" }])).toBe(false);
  });
});

// Classification insert shapes.
//   'pending'    — the row is still being repaired/populated; it must NEVER
//                  flash into any settled view.
//   'pending_ai' — fully parsed, only waiting on the AI step; it IS surfaced
//                  in the Inbox immediately (so new mail appears instantly),
//                  then settles into its folder once AI lands. It stays
//                  hidden from No-rules / folder views.
// The rules-final row goes straight to its folder; 'all_mail' shows
// everything including in-progress mail (diagnostic view).
describe("rowBelongsInList — classification insert shapes", () => {
  // Real inbox query keys are ["emails", accountId, scope, pageKey].
  const key = (scope: string) => ["emails", ACC, scope, "page:1:start"];

  it("a pending_ai row shows in the inbox immediately but stays out of no-rules/folder views", () => {
    const pending = row({ folder_id: null, is_archived: false, classified_by: "pending_ai" });
    // Surfaced in the inbox the moment it arrives (INBOX label + not archived).
    expect(rowBelongsInList(pending, key("all"))).toBe(true);
    // ...but still hidden from the settled No-rules / folder views.
    expect(rowBelongsInList(pending, key("no_rules"))).toBe(false);
    expect(rowBelongsInList(pending, key("f-work"))).toBe(false);
    // The diagnostic All-mail scope also surfaces it.
    expect(rowBelongsInList(pending, key("all_mail"))).toBe(true);
  });

  it("a pending_ai row that is not in the inbox (archived / no INBOX label) is not surfaced", () => {
    expect(
      rowBelongsInList(
        row({ raw_labels: ["INBOX"], is_archived: true, classified_by: "pending_ai" }),
        key("all"),
      ),
    ).toBe(false);
    expect(
      rowBelongsInList(row({ raw_labels: [], classified_by: "pending_ai" }), key("all")),
    ).toBe(false);
  });

  it("a pending row is hidden from the inbox until classification settles", () => {
    const pending = row({ folder_id: null, is_archived: false, classified_by: "pending" });
    expect(rowBelongsInList(pending, key("all"))).toBe(false);
  });

  it("once settled, an AI-classified inbox row belongs in the inbox", () => {
    const settled = row({ folder_id: null, is_archived: false, classified_by: "ai" });
    expect(rowBelongsInList(settled, key("all"))).toBe(true);
  });

  it("a rules-final auto-archived row belongs in its folder, NOT the inbox", () => {
    const routed = row({ folder_id: "f-work", is_archived: true, classified_by: "filter" });
    expect(rowBelongsInList(routed, key("f-work"))).toBe(true);
    expect(rowBelongsInList(routed, key("all"))).toBe(false);
  });

  it("a settled row in an auto-archived folder stays out of the inbox even before local archive flags catch up", () => {
    const routed = row({
      folder_id: "f-work",
      is_archived: false,
      classified_by: "ai",
      folder: { auto_archive: true, hide_from_inbox: false },
    });
    expect(rowBelongsInList(routed, key("f-work"))).toBe(true);
    expect(rowBelongsInList(routed, key("all"))).toBe(false);
  });
});

// The coalescer flushes a buffered set of INSERT/UPDATE/DELETE ops in
// one shot. A catch-up burst of N inserts must produce ONE next-list
// (one React render) instead of N.
describe("applyPendingOpsToList — coalesced flush", () => {
  const baseRow = (id: string, received_at: string): EmailRow => ({
    id,
    user_id: "u1",
    gmail_message_id: `m-${id}`,
    received_at,
    is_archived: false,
    folder_id: null,
    raw_labels: ["INBOX"],
  });

  it("applies N inserts in one call, sorted by received_at desc", () => {
    const existing = [baseRow("a", "2024-01-01T00:00:00Z")];
    const ops: import("./use-email-realtime").PendingRealtimeOp[] = [
      { kind: "insert", row: baseRow("b", "2024-01-03T00:00:00Z") },
      { kind: "insert", row: baseRow("c", "2024-01-02T00:00:00Z") },
      { kind: "insert", row: baseRow("d", "2024-01-04T00:00:00Z") },
    ];
    const { next, needsRefetch } = applyPendingOpsToList(existing, ops, ["emails", "inbox"]);
    expect(needsRefetch).toBe(false);
    expect(next?.map((r) => r.id)).toEqual(["d", "b", "c", "a"]);
  });

  it("returns next=null when no op applies (no spurious render)", () => {
    const existing = [baseRow("a", "2024-01-01T00:00:00Z")];
    const ops: import("./use-email-realtime").PendingRealtimeOp[] = [
      // archived row to inbox list — rejected by rowBelongsInList
      { kind: "insert", row: { ...baseRow("b", "2024-01-02T00:00:00Z"), is_archived: true } },
    ];
    const { next } = applyPendingOpsToList(existing, ops, [
      "emails",
      "acc-1",
      "all",
      "page:1:start",
    ]);
    expect(next).toBeNull();
  });

  it("update for a row that now belongs but isn't present signals refetch", () => {
    const existing = [baseRow("a", "2024-01-01T00:00:00Z")];
    const ops: import("./use-email-realtime").PendingRealtimeOp[] = [
      { kind: "update", row: { ...baseRow("z", "2024-02-01T00:00:00Z"), folder_id: "f-1" } },
    ];
    const { next, needsRefetch } = applyPendingOpsToList(existing, ops, ["emails", "f-1"]);
    expect(needsRefetch).toBe(true);
    expect(next).toBeNull();
  });

  it("mix of insert + update for the same id merges correctly in one pass", () => {
    const existing = [baseRow("a", "2024-01-01T00:00:00Z")];
    const ops: import("./use-email-realtime").PendingRealtimeOp[] = [
      { kind: "insert", row: baseRow("b", "2024-01-05T00:00:00Z") },
      { kind: "update", row: { ...baseRow("b", "2024-01-05T00:00:00Z"), classified_by: "ai" } },
    ];
    const { next } = applyPendingOpsToList(existing, ops, ["emails", "inbox"]);
    expect(next).toHaveLength(2);
    expect(next?.[0].id).toBe("b");
    expect(next?.[0].classified_by).toBe("ai");
  });
});

// A damaged push (the realtime service strips oversized rows or attaches an
// error notice) must be detected so the hook falls back to a re-fetch instead
// of splicing a broken row — or worse, silently ignoring a real change.
describe("isDamagedPayload", () => {
  it("accepts clean INSERT/UPDATE payloads", () => {
    expect(isDamagedPayload({ eventType: "INSERT", errors: null, new: row() })).toBe(false);
    expect(isDamagedPayload({ eventType: "UPDATE", errors: [], new: row() })).toBe(false);
  });

  it("accepts a DELETE payload that only carries the primary key", () => {
    expect(
      isDamagedPayload({ eventType: "DELETE", errors: null, old: { id: "row-1" }, new: {} }),
    ).toBe(false);
  });

  it("flags service errors even when a row is attached", () => {
    expect(
      isDamagedPayload({
        eventType: "UPDATE",
        errors: ["Error 413: Payload Too Large"],
        new: row(),
      }),
    ).toBe(true);
  });

  it("flags payloads whose row is missing or lacks an id", () => {
    expect(isDamagedPayload({ eventType: "INSERT", errors: null, new: {} })).toBe(true);
    expect(isDamagedPayload({ eventType: "UPDATE", errors: null })).toBe(true);
    expect(isDamagedPayload({ eventType: "DELETE", errors: null, old: {}, new: {} })).toBe(true);
  });
});
