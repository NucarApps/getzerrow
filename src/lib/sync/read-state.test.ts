import { describe, it, expect } from "vitest";
import { diffReadState } from "./read-state";

describe("diffReadState", () => {
  it("marks local-unread rows read when Gmail no longer lists them as unread", () => {
    const gmailUnread = new Set<string>(["g2"]);
    const localUnread = [
      { id: "a", gmail_message_id: "g1" }, // read in Gmail now
      { id: "b", gmail_message_id: "g2" }, // still unread in Gmail
    ];
    const { toMarkRead, toMarkUnread } = diffReadState(gmailUnread, localUnread, []);
    expect(toMarkRead).toEqual(["a"]);
    expect(toMarkUnread).toEqual([]);
  });

  it("marks local-read rows unread when Gmail lists them as unread", () => {
    const gmailUnread = new Set<string>(["g3"]);
    const localReadInSet = [{ id: "c", gmail_message_id: "g3" }];
    const { toMarkRead, toMarkUnread } = diffReadState(gmailUnread, [], localReadInSet);
    expect(toMarkRead).toEqual([]);
    expect(toMarkUnread).toEqual(["c"]);
  });

  it("returns empty lists when everything already matches", () => {
    const gmailUnread = new Set<string>(["g1"]);
    const localUnread = [{ id: "a", gmail_message_id: "g1" }];
    const { toMarkRead, toMarkUnread } = diffReadState(gmailUnread, localUnread, []);
    expect(toMarkRead).toEqual([]);
    expect(toMarkUnread).toEqual([]);
  });

  it("handles both directions in a single pass", () => {
    const gmailUnread = new Set<string>(["g2", "g4"]);
    const localUnread = [
      { id: "a", gmail_message_id: "g1" }, // -> read
      { id: "b", gmail_message_id: "g2" }, // unchanged
    ];
    const localReadInSet = [{ id: "d", gmail_message_id: "g4" }]; // -> unread
    const { toMarkRead, toMarkUnread } = diffReadState(gmailUnread, localUnread, localReadInSet);
    expect(toMarkRead).toEqual(["a"]);
    expect(toMarkUnread).toEqual(["d"]);
  });
});
