// parseMessage is pure — given a Gmail v1 message JSON it produces the row
// shape we insert into `emails`. These tests pin the contract so changes to
// header handling or MIME walking don't silently break inbox display.
import { describe, it, expect } from "vitest";
import { parseMessage, GmailApiError } from "./gmail.server";

function b64url(s: string): string {
  return Buffer.from(s, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function msg(opts: {
  id?: string;
  threadId?: string;
  internalDate?: number;
  headers?: Record<string, string>;
  snippet?: string;
  labelIds?: string[];
  textBody?: string;
  htmlBody?: string;
  attachments?: string[];
  calendarPart?: boolean;
  icsAttachment?: boolean;
}) {
  const headers = Object.entries(opts.headers ?? {}).map(([name, value]) => ({ name, value }));
  const parts: unknown[] = [];
  if (opts.textBody !== undefined) {
    parts.push({ mimeType: "text/plain", body: { data: b64url(opts.textBody) } });
  }
  if (opts.htmlBody !== undefined) {
    parts.push({ mimeType: "text/html", body: { data: b64url(opts.htmlBody) } });
  }
  if (opts.calendarPart) {
    parts.push({
      mimeType: 'text/calendar; method=REQUEST; charset="UTF-8"',
      body: { data: b64url("BEGIN:VCALENDAR\nEND:VCALENDAR") },
    });
  }
  if (opts.icsAttachment) {
    parts.push({ filename: "invite.ics", body: { attachmentId: "att-ics" } });
  }
  for (const filename of opts.attachments ?? []) {
    parts.push({ filename, body: { attachmentId: `att-${filename}` } });
  }
  return {
    id: opts.id ?? "m1",
    threadId: opts.threadId ?? "t1",
    internalDate: String(opts.internalDate ?? Date.UTC(2026, 0, 15, 10, 30)),
    snippet: opts.snippet ?? "hello",
    labelIds: opts.labelIds ?? ["INBOX"],
    payload: { headers, parts },
  };
}

describe("parseMessage", () => {
  it("extracts name + email from a `Name <addr>` From header", () => {
    const p = parseMessage(
      msg({ headers: { From: '"Alice Sender" <alice@example.com>', Subject: "Hi" } }),
    );
    expect(p.from_name).toBe("Alice Sender");
    expect(p.from_addr).toBe("alice@example.com");
  });

  it("handles a bare-email From header (no angle brackets)", () => {
    const p = parseMessage(msg({ headers: { From: "bob@example.com" } }));
    expect(p.from_name).toBe("");
    expect(p.from_addr).toBe("bob@example.com");
  });

  it("populates standard headers (to/cc/list-id/in-reply-to/subject)", () => {
    const p = parseMessage(
      msg({
        headers: {
          From: "a@x.com",
          To: "b@x.com, c@x.com",
          Cc: "d@x.com",
          Subject: "RFP response",
          "List-Id": "<list.x.com>",
          "In-Reply-To": "<orig-msg@x.com>",
        },
      }),
    );
    expect(p.to_addrs).toBe("b@x.com, c@x.com");
    expect(p.cc).toBe("d@x.com");
    expect(p.subject).toBe("RFP response");
    expect(p.list_id).toBe("<list.x.com>");
    expect(p.in_reply_to).toBe("<orig-msg@x.com>");
  });

  it("returns empty strings for missing headers (not undefined)", () => {
    // Downstream classification logic uses .toLowerCase() etc and relies on strings.
    const p = parseMessage(msg({ headers: { From: "a@x.com" } }));
    expect(p.to_addrs).toBe("");
    expect(p.cc).toBe("");
    expect(p.list_id).toBe("");
    expect(p.in_reply_to).toBe("");
    expect(p.subject).toBe("");
  });

  it("is case-insensitive on header names", () => {
    const p = parseMessage(
      msg({
        headers: { from: "lower@x.com", SUBJECT: "Yelling" },
      }),
    );
    expect(p.from_addr).toBe("lower@x.com");
    expect(p.subject).toBe("Yelling");
  });

  it("decodes base64url text/plain and text/html bodies", () => {
    const p = parseMessage(
      msg({
        headers: { From: "a@x.com" },
        textBody: "Plain text body with — em dash",
        htmlBody: "<p>HTML body</p>",
      }),
    );
    expect(p.body_text).toBe("Plain text body with — em dash");
    expect(p.body_html).toBe("<p>HTML body</p>");
  });

  it("detects attachments by walking parts", () => {
    const p = parseMessage(
      msg({
        headers: { From: "a@x.com" },
        textBody: "body",
        attachments: ["report.pdf"],
      }),
    );
    expect(p.has_attachment).toBe(true);
  });

  it("has_attachment is false when no parts have filenames", () => {
    const p = parseMessage(msg({ headers: { From: "a@x.com" }, textBody: "body" }));
    expect(p.has_attachment).toBe(false);
  });

  it("has_calendar_invite is true for a text/calendar part", () => {
    const p = parseMessage(msg({ headers: { From: "a@x.com" }, textBody: "body", calendarPart: true }));
    expect(p.has_calendar_invite).toBe(true);
  });

  it("has_calendar_invite is true for an .ics attachment", () => {
    const p = parseMessage(msg({ headers: { From: "a@x.com" }, textBody: "body", icsAttachment: true }));
    expect(p.has_calendar_invite).toBe(true);
  });

  it("has_calendar_invite is false for a plain reply with no calendar event", () => {
    const p = parseMessage(
      msg({ headers: { From: "a@x.com", "In-Reply-To": "<orig@x.com>" }, textBody: "Sure, sounds good" }),
    );
    expect(p.has_calendar_invite).toBe(false);
  });


  it("sets is_read based on UNREAD label", () => {
    const unread = parseMessage(
      msg({ headers: { From: "a@x.com" }, labelIds: ["INBOX", "UNREAD"] }),
    );
    const read = parseMessage(msg({ headers: { From: "a@x.com" }, labelIds: ["INBOX"] }));
    expect(unread.is_read).toBe(false);
    expect(read.is_read).toBe(true);
  });

  it("converts Gmail internalDate (ms epoch) to ISO string", () => {
    const at = Date.UTC(2026, 4, 25, 10, 30, 0);
    const p = parseMessage(msg({ headers: { From: "a@x.com" }, internalDate: at }));
    expect(p.received_at).toBe(new Date(at).toISOString());
  });

  it("passes through raw_labels for downstream label routing", () => {
    const labels = ["INBOX", "IMPORTANT", "Label_42", "CATEGORY_PERSONAL"];
    const p = parseMessage(msg({ headers: { From: "a@x.com" }, labelIds: labels }));
    expect(p.raw_labels).toEqual(labels);
  });

  it("handles nested multipart payloads (multipart/alternative inside multipart/mixed)", () => {
    const nested = {
      id: "m1",
      threadId: "t1",
      internalDate: String(Date.UTC(2026, 0, 15)),
      snippet: "s",
      labelIds: ["INBOX"],
      payload: {
        headers: [{ name: "From", value: "a@x.com" }],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64url("plain inside") } },
              { mimeType: "text/html", body: { data: b64url("<b>html inside</b>") } },
            ],
          },
        ],
      },
    };
    const p = parseMessage(nested);
    expect(p.body_text).toBe("plain inside");
    expect(p.body_html).toBe("<b>html inside</b>");
  });

  it("doesn't crash on totally missing payload", () => {
    const p = parseMessage({ id: "m1", threadId: "t1", internalDate: "0", snippet: "" });
    expect(p.from_addr).toBe("");
    expect(p.body_text).toBe("");
    expect(p.has_attachment).toBe(false);
  });
});

describe("GmailApiError", () => {
  it("carries status + retryable + Retry-After + quota flags", () => {
    const e = new GmailApiError("rate limited", 429, true, {
      retryAfterSeconds: 30,
      isQuotaExceeded: true,
    });
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);
    expect(e.retryAfterSeconds).toBe(30);
    expect(e.isQuotaExceeded).toBe(true);
    expect(e instanceof Error).toBe(true);
    expect(e instanceof GmailApiError).toBe(true);
  });

  it("defaults retryAfterSeconds + isQuotaExceeded when not provided", () => {
    const e = new GmailApiError("boom", 500, true);
    expect(e.retryAfterSeconds).toBeNull();
    expect(e.isQuotaExceeded).toBe(false);
  });
});
