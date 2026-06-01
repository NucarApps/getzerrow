// Unit coverage for extractAttendeeEmails — the pure parser that pulls
// distinct attendee/organizer/creator addresses out of a single calendar
// event, excluding the account owner and Google resource calendars.
import { describe, it, expect } from "vitest";
import { extractAttendeeEmails, CalendarApiError } from "./calendar.server";

const self = "me@example.com";

describe("extractAttendeeEmails", () => {
  it("returns attendee emails excluding the account owner", () => {
    const out = extractAttendeeEmails(
      { attendees: [{ email: "a@partner.com" }, { email: self, self: true }] },
      self,
    );
    expect(out).toEqual(["a@partner.com"]);
  });

  it("excludes the owner even when self flag is missing but address matches", () => {
    const out = extractAttendeeEmails(
      { attendees: [{ email: "Me@Example.com" }, { email: "b@partner.com" }] },
      self,
    );
    expect(out).toEqual(["b@partner.com"]);
  });

  it("lowercases and de-duplicates addresses", () => {
    const out = extractAttendeeEmails(
      {
        attendees: [{ email: "Dup@Partner.com" }, { email: "dup@partner.com" }],
        organizer: { email: "DUP@partner.com" },
      },
      self,
    );
    expect(out).toEqual(["dup@partner.com"]);
  });

  it("includes organizer and creator addresses", () => {
    const out = extractAttendeeEmails(
      { organizer: { email: "org@partner.com" }, creator: { email: "creator@partner.com" } },
      self,
    );
    expect(out.sort()).toEqual(["creator@partner.com", "org@partner.com"]);
  });

  it("skips Google resource calendars (rooms / equipment)", () => {
    const out = extractAttendeeEmails(
      {
        attendees: [
          { email: "room@resource.calendar.google.com" },
          { email: "team@partner.com" },
        ],
      },
      self,
    );
    expect(out).toEqual(["team@partner.com"]);
  });

  it("ignores malformed or empty addresses", () => {
    const out = extractAttendeeEmails(
      { attendees: [{ email: "not-an-email" }, { email: "" }, { email: undefined }] },
      self,
    );
    expect(out).toEqual([]);
  });

  it("returns an empty array for an event with no participants", () => {
    expect(extractAttendeeEmails({}, self)).toEqual([]);
  });
});
