import { describe, it, expect } from "vitest";
import { toEmailUpsert, type ParsedForUpsert } from "./email-upsert";

// This mapping was spelled out at five call sites, which is how they drifted on
// which fields they set. The defaults below ARE the contract for the four
// ingest paths; the live classify path overrides them explicitly.

function parsed(over: Partial<ParsedForUpsert> = {}): ParsedForUpsert {
  return {
    gmail_message_id: "m1",
    thread_id: "t1",
    from_addr: "jane@acme.com",
    from_name: "Jane",
    to_addrs: "me@example.com",
    subject: "Hi",
    snippet: "snip",
    body_text: "body",
    body_html: "<p>body</p>",
    received_at: "2026-01-01T00:00:00Z",
    is_read: false,
    has_attachment: false,
    raw_labels: ["INBOX"],
    ...over,
  };
}

const base = { user_id: "u1", gmail_account_id: "a1", classified_by: "pending" };

describe("toEmailUpsert", () => {
  it("carries the parsed fields through unchanged", () => {
    const row = toEmailUpsert(parsed(), base);
    expect(row).toMatchObject({
      user_id: "u1",
      gmail_account_id: "a1",
      classified_by: "pending",
      gmail_message_id: "m1",
      thread_id: "t1",
      from_addr: "jane@acme.com",
      subject: "Hi",
      body_text: "body",
      received_at: "2026-01-01T00:00:00Z",
    });
  });

  it("defaults headers and processing timestamps to null (the ingest shape)", () => {
    expect(toEmailUpsert(parsed(), base)).toMatchObject({
      cc: null,
      list_id: null,
      in_reply_to: null,
      processed_at: null,
      published_at_ms: null,
    });
  });

  it("derives is_archived from the absence of the INBOX label", () => {
    expect(toEmailUpsert(parsed({ raw_labels: ["INBOX"] }), base).is_archived).toBe(false);
    expect(toEmailUpsert(parsed({ raw_labels: ["Label_1"] }), base).is_archived).toBe(true);
  });

  it("treats missing labels as archived rather than throwing", () => {
    expect(toEmailUpsert(parsed({ raw_labels: null }), base).is_archived).toBe(true);
  });

  it("lets the live path override the derived and defaulted fields", () => {
    const row = toEmailUpsert(parsed({ raw_labels: ["INBOX"] }), {
      ...base,
      cc: "cc@example.com",
      list_id: "<list>",
      in_reply_to: "<orig>",
      is_read: true,
      is_archived: true,
      processed_at: "2026-01-02T00:00:00Z",
      published_at_ms: 1234,
    });
    expect(row).toMatchObject({
      cc: "cc@example.com",
      list_id: "<list>",
      in_reply_to: "<orig>",
      is_read: true,
      // explicit override wins over the INBOX-derived default
      is_archived: true,
      processed_at: "2026-01-02T00:00:00Z",
      published_at_ms: 1234,
    });
  });

  it("lets folder-learn drop bodies while keeping headers", () => {
    const row = toEmailUpsert(parsed(), { ...base, body_text: null, body_html: null });
    expect(row.body_text).toBeNull();
    expect(row.body_html).toBeNull();
    expect(row.subject).toBe("Hi");
  });

  it("passes through a parsed cc/list_id when present", () => {
    const row = toEmailUpsert(parsed({ cc: "x@y.com", list_id: "<l>" }), base);
    expect(row.cc).toBe("x@y.com");
    expect(row.list_id).toBe("<l>");
  });
});
