import { describe, expect, it } from "vitest";
import { autoApplicableIds, buildChangeSet, describeChangeSet, type ReplayMessage } from "./replay";
import type { EvaluateContext, Rule } from "./types";

const context = (rules: Rule[]): EvaluateContext => ({
  folders: [
    { id: "receipts", name: "Receipts" },
    { id: "finance", name: "Finance" },
  ],
  rules,
  pins: [],
  guardrails: [],
});

const netflixRule: Rule = {
  id: "r1",
  folder_id: "receipts",
  created_at: "2026-01-01T00:00:00.000Z",
  groups: [[{ field: "from", op: "contains", value: "billing@netflix.com" }]],
};

const msg = (over: Partial<ReplayMessage> & { id: string }): ReplayMessage => ({
  from_addr: "billing@netflix.com",
  from_name: "Netflix",
  to_addrs: "me@example.com",
  subject: "Your receipt",
  body_text: "",
  has_attachment: false,
  folder_id: null,
  received_at: "2026-08-01T00:00:00.000Z",
  ...over,
});

describe("buildChangeSet", () => {
  it("reports only messages whose folder changes", () => {
    const set = buildChangeSet(
      [msg({ id: "e1" }), msg({ id: "e2", folder_id: "receipts" })],
      context([netflixRule]),
    );
    expect(set.scanned).toBe(2);
    expect(set.entries).toHaveLength(1);
    expect(set.entries[0]).toMatchObject({
      email_id: "e1",
      action: "move",
      from_folder_name: "Inbox",
      to_folder_name: "Receipts",
      requires_review: false,
      locked: false,
    });
    expect(set.move_count).toBe(1);
  });

  // CHARACTERIZATION(replay-ignores-gmail-label-placement): buildChangeSet
  // evaluates with skipGmailLabelMatch:true, so stage 3 (the Gmail label
  // mirror) never runs. Mail the user filed in Gmail itself, which the live
  // pipeline files by label every time, looks unexplained to the replay and
  // is proposed for a move to the Inbox — and planner-apply's applyMoves
  // would carry that out.
  it("proposes moving label-filed mail to the Inbox, because it never runs the label mirror", () => {
    const labelled: EvaluateContext = {
      ...context([netflixRule]),
      folders: [
        { id: "receipts", name: "Receipts" },
        { id: "finance", name: "Finance", gmail_label_id: "Label_finance" },
      ],
    };
    const set = buildChangeSet(
      [
        msg({
          id: "e1",
          from_addr: "statements@bank.test",
          from_name: "Bank",
          subject: "Your statement",
          folder_id: "finance",
          raw_labels: ["Label_finance"],
        }),
      ],
      labelled,
    );
    expect(set.entries).toHaveLength(1);
    expect(set.entries[0]).toMatchObject({
      email_id: "e1",
      action: "move",
      from_folder_name: "Finance",
      to_folder_id: null,
      to_folder_name: "Inbox",
      locked: false,
      // Not even flagged for review: nothing marks it as user-placed.
      requires_review: false,
    });
    expect(autoApplicableIds(set)).toEqual(["e1"]);
  });

  it("never moves hand-placed mail", () => {
    const set = buildChangeSet([msg({ id: "e1", placed_by_user: true })], context([netflixRule]));
    expect(set.entries[0]).toMatchObject({
      action: "keep",
      locked: true,
      to_folder_name: "Inbox",
    });
    expect(set.move_count).toBe(0);
    expect(set.locked_count).toBe(1);
    expect(autoApplicableIds(set)).toEqual([]);
  });

  it("flags moves out of a confirmed placement and excludes them from Apply All", () => {
    const set = buildChangeSet(
      [
        msg({
          id: "e1",
          folder_id: "finance",
          decision_confirmed_at: "2026-07-01T00:00:00.000Z",
        }),
        msg({ id: "e2" }),
      ],
      context([netflixRule]),
    );
    expect(set.requires_review_count).toBe(1);
    expect(autoApplicableIds(set)).toEqual(["e2"]);
  });

  it("runs with the AI stage off, so undecidable mail stays in the Inbox", () => {
    const set = buildChangeSet(
      [msg({ id: "e1", from_addr: "hello@unknown.com", folder_id: "receipts" })],
      {
        ...context([netflixRule]),
        folders: [
          { id: "receipts", name: "Receipts", description: "anything at all" },
          { id: "finance", name: "Finance" },
        ],
      },
    );
    expect(set.entries[0]).toMatchObject({ to_folder_name: "Inbox", action: "move" });
  });

  it("summarises the diff for the dialog headline", () => {
    const set = buildChangeSet(
      [msg({ id: "e1" }), msg({ id: "e2" }), msg({ id: "e3", subject: "x" })],
      context([netflixRule]),
    );
    expect(set.summary).toEqual([{ from: "Inbox", to: "Receipts", count: 3 }]);
    expect(describeChangeSet(set)).toBe("Affects 3: 3 Inbox → Receipts");
    expect(describeChangeSet(buildChangeSet([], context([netflixRule])))).toBe(
      "No existing mail changes folders.",
    );
  });
});
