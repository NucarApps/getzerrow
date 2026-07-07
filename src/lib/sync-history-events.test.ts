// Regression tests for the Gmail history-walk "new mail" extraction.
//
// The bug: label-only history records (e.g. the user archived a message
// in Gmail → labelsRemoved: ["INBOX"]) also carry a generic `messages`
// list. The old fallback (`h.messagesAdded ?? h.messages`) treated those
// as newly-added mail, which put them in the walk's seenAdded set — and
// the walk skips label ops for seenAdded messages, so the archive signal
// was silently dropped. Archiving in Gmail never reached Zerrow.
import { describe, it, expect } from "vitest";
import { collectAddedMessages, type GmailHistoryRecord } from "./sync/history-events";

describe("collectAddedMessages", () => {
  it("does NOT treat an archive event (labelsRemoved-only record) as new mail", () => {
    const record: GmailHistoryRecord = {
      messages: [{ id: "m1" }],
      labelsRemoved: [{ message: { id: "m1", labelIds: ["UNREAD"] }, labelIds: ["INBOX"] }],
    };
    expect(collectAddedMessages(record)).toEqual([]);
  });

  it("does NOT treat an un-archive event (labelsAdded-only record) as new mail", () => {
    const record: GmailHistoryRecord = {
      messages: [{ id: "m2" }],
      labelsAdded: [{ message: { id: "m2", labelIds: ["INBOX"] }, labelIds: ["INBOX"] }],
    };
    expect(collectAddedMessages(record)).toEqual([]);
  });

  it("does NOT treat a delete event as new mail", () => {
    const record: GmailHistoryRecord = {
      messages: [{ id: "m3" }],
      messagesDeleted: [{ message: { id: "m3" } }],
    };
    expect(collectAddedMessages(record)).toEqual([]);
  });

  it("returns messagesAdded when present", () => {
    const record: GmailHistoryRecord = {
      messages: [{ id: "m4" }],
      messagesAdded: [{ message: { id: "m4", labelIds: ["INBOX", "UNREAD"] } }],
    };
    expect(collectAddedMessages(record).map((m) => m.id)).toEqual(["m4"]);
  });

  it("still returns messagesAdded when the same record also has label events", () => {
    // New mail that was immediately labeled — messagesAdded stays
    // authoritative; the label state comes from parseMessage when the
    // queued job runs.
    const record: GmailHistoryRecord = {
      messages: [{ id: "m5" }],
      messagesAdded: [{ message: { id: "m5" } }],
      labelsAdded: [{ message: { id: "m5" }, labelIds: ["Label_1"] }],
    };
    expect(collectAddedMessages(record).map((m) => m.id)).toEqual(["m5"]);
  });

  it("falls back to the generic messages list ONLY for records with no typed arrays", () => {
    // Defensive: unexpected record shape — better to ingest than drop.
    const record: GmailHistoryRecord = {
      messages: [{ id: "m6" }],
    };
    expect(collectAddedMessages(record).map((m) => m.id)).toEqual(["m6"]);
  });

  it("returns [] for an empty record", () => {
    expect(collectAddedMessages({})).toEqual([]);
  });
});
