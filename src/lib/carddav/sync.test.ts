import { describe, expect, it } from "vitest";
import { parseSyncCollection } from "./xml";

describe("parseSyncCollection", () => {
  it("returns empty token / default level for initial sync", () => {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<D:sync-collection xmlns:D="DAV:">' +
      "<D:sync-token/>" +
      "<D:sync-level>1</D:sync-level>" +
      "<D:prop><D:getetag/></D:prop>" +
      "</D:sync-collection>";
    const parsed = parseSyncCollection(body);
    expect(parsed.syncToken).toBe("");
    expect(parsed.syncLevel).toBe("1");
    expect(parsed.limit).toBeNull();
  });

  it("reads an existing sync-token and nresults limit", () => {
    const body =
      '<D:sync-collection xmlns:D="DAV:">' +
      "<D:sync-token>urn:zerrow:carddav:u1:1234:5</D:sync-token>" +
      "<D:sync-level>1</D:sync-level>" +
      "<D:limit><D:nresults>50</D:nresults></D:limit>" +
      "<D:prop><D:getetag/></D:prop>" +
      "</D:sync-collection>";
    const parsed = parseSyncCollection(body);
    expect(parsed.syncToken).toBe("urn:zerrow:carddav:u1:1234:5");
    expect(parsed.syncLevel).toBe("1");
    expect(parsed.limit).toBe(50);
  });

  it("tolerates missing sync-level (defaults to 1)", () => {
    const body = '<D:sync-collection xmlns:D="DAV:"></D:sync-collection>';
    const parsed = parseSyncCollection(body);
    expect(parsed.syncToken).toBe("");
    expect(parsed.syncLevel).toBe("1");
    expect(parsed.limit).toBeNull();
  });

  it("ignores non-positive nresults", () => {
    const body =
      '<D:sync-collection xmlns:D="DAV:">' +
      "<D:limit><D:nresults>0</D:nresults></D:limit>" +
      "</D:sync-collection>";
    expect(parseSyncCollection(body).limit).toBeNull();
  });
});
