// The hand-rolled XML layer behind every CardDAV response. It was previously
// filed as `sync.test.ts`, which named neither the module under test nor
// anything that exists.
import { describe, expect, it } from "vitest";
import {
  parseSyncCollection,
  parseMultigetHrefs,
  parseRequestedProps,
  propfindResponseBlock,
  responseBlock,
  statusResponseBlock,
  davResponse,
  xmlEscape,
  MULTISTATUS_OPEN,
  MULTISTATUS_CLOSE,
  NS_CARDDAV,
  NS_DAV,
  type PropSpec,
} from "./xml";
import { contactToVCard } from "./vcard";
import type { DecryptedContact } from "@/lib/sync/encrypted-reader";

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
      "<D:sync-token>urn:atzro:carddav:u1:1234:5</D:sync-token>" +
      "<D:sync-level>1</D:sync-level>" +
      "<D:limit><D:nresults>50</D:nresults></D:limit>" +
      "<D:prop><D:getetag/></D:prop>" +
      "</D:sync-collection>";
    const parsed = parseSyncCollection(body);
    expect(parsed.syncToken).toBe("urn:atzro:carddav:u1:1234:5");
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

describe("parseMultigetHrefs", () => {
  it("reads every href regardless of namespace prefix and trims whitespace", () => {
    const body =
      '<C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">' +
      "<D:href>\n  /api/public/carddav/a%40b.test/contacts/one.vcf\n</D:href>" +
      "<href>/api/public/carddav/a%40b.test/contacts/two.vcf</href>" +
      "<x:href>/api/public/carddav/a%40b.test/contacts/three.vcf</x:href>" +
      "</C:addressbook-multiget>";
    expect(parseMultigetHrefs(body)).toEqual([
      "/api/public/carddav/a%40b.test/contacts/one.vcf",
      "/api/public/carddav/a%40b.test/contacts/two.vcf",
      "/api/public/carddav/a%40b.test/contacts/three.vcf",
    ]);
  });

  it("skips empty href elements and returns nothing for a body with none", () => {
    expect(parseMultigetHrefs("<D:href></D:href><D:href>   </D:href>")).toEqual([]);
    expect(parseMultigetHrefs("<D:propfind/>")).toEqual([]);
  });
});

describe("parseRequestedProps", () => {
  it("resolves each requested prop to (namespace, local name) via the xmlns bindings", () => {
    const body =
      '<?xml version="1.0"?>' +
      '<A:propfind xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:carddav">' +
      "<A:prop><A:getetag/><B:address-data/></A:prop>" +
      "</A:propfind>";
    expect(parseRequestedProps(body)).toStrictEqual([
      { ns: NS_DAV, name: "getetag" },
      { ns: NS_CARDDAV, name: "address-data" },
    ]);
  });

  it("honours a default xmlns for unprefixed children", () => {
    const body = '<propfind xmlns="DAV:"><prop><displayname/></prop></propfind>';
    expect(parseRequestedProps(body)).toStrictEqual([{ ns: NS_DAV, name: "displayname" }]);
  });

  it("returns null for allprop, an empty prop list, no body, and unreadable XML", () => {
    // Null is "render the full set" — the behaviour every request got before
    // subsets were honoured, so an odd request is never worse off.
    expect(parseRequestedProps('<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>')).toBeNull();
    expect(
      parseRequestedProps('<D:propfind xmlns:D="DAV:"><D:prop></D:prop></D:propfind>'),
    ).toBeNull();
    expect(parseRequestedProps("")).toBeNull();
    expect(parseRequestedProps(undefined)).toBeNull();
    expect(parseRequestedProps("<propfind><not-closed")).toBeNull();
  });

  it("does not mistake a REPORT's prop-filter for a prop element", () => {
    // addressbook-query bodies carry <C:prop-filter>; matching it here would
    // make a query look like a prop subset request.
    const body =
      '<C:addressbook-query xmlns:C="urn:ietf:params:xml:ns:carddav">' +
      '<C:filter><C:prop-filter name="FN"/></C:filter>' +
      "</C:addressbook-query>";
    expect(parseRequestedProps(body)).toBeNull();
  });
});

describe("propfindResponseBlock", () => {
  const available: PropSpec[] = [
    { ns: NS_DAV, name: "displayname", xml: "<D:displayname>Book</D:displayname>" },
    { ns: NS_DAV, name: "getetag", xml: '<D:getetag>"e"</D:getetag>' },
  ];

  it("returns every available prop in one 200 propstat when nothing was requested", () => {
    expect(propfindResponseBlock("/book/", available, null)).toBe(
      responseBlock("/book/", '<D:displayname>Book</D:displayname><D:getetag>"e"</D:getetag>'),
    );
  });

  it("splits the requested props into a 200 and a 404 propstat", () => {
    const block = propfindResponseBlock("/book/", available, [
      { ns: NS_DAV, name: "displayname" },
      { ns: "urn:example:custom", name: "no-such-prop" },
    ]);
    expect(block).toBe(
      "<D:response><D:href>/book/</D:href>" +
        "<D:propstat><D:prop><D:displayname>Book</D:displayname></D:prop>" +
        "<D:status>HTTP/1.1 200 OK</D:status></D:propstat>" +
        '<D:propstat><D:prop><x:no-such-prop xmlns:x="urn:example:custom"/></D:prop>' +
        "<D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>" +
        "</D:response>",
    );
  });

  it("omits the 404 propstat entirely when every requested prop was found", () => {
    const block = propfindResponseBlock("/book/", available, [{ ns: NS_DAV, name: "getetag" }]);
    expect(block).not.toContain("404");
    expect(block).toContain('<D:prop><D:getetag>"e"</D:getetag></D:prop>');
  });

  it("treats the same local name in another namespace as a different property", () => {
    const block = propfindResponseBlock("/book/", available, [
      { ns: "urn:example:other", name: "displayname" },
    ]);
    expect(block).toContain('<x:displayname xmlns:x="urn:example:other"/>');
    expect(block).not.toContain("Book");
  });
});

describe("statusResponseBlock", () => {
  it("carries a bare status with no propstat, and escapes the href", () => {
    expect(statusResponseBlock("/book/a&b.vcf")).toBe(
      "<D:response><D:href>/book/a&amp;b.vcf</D:href>" +
        "<D:status>HTTP/1.1 404 Not Found</D:status></D:response>",
    );
  });
});

describe("xmlEscape", () => {
  it("escapes every character that would break out of an element or attribute", () => {
    expect(xmlEscape(`Tom & "Jerry" <'co'>`)).toBe(
      "Tom &amp; &quot;Jerry&quot; &lt;&apos;co&apos;&gt;",
    );
  });

  it("escapes the ampersand first so entities are not double-built", () => {
    // Escaping `<` before `&` would turn "<" into "&lt;" and then into
    // "&amp;lt;" on the ampersand pass.
    expect(xmlEscape("<")).toBe("&lt;");
    expect(xmlEscape("&lt;")).toBe("&amp;lt;");
  });
});

describe("address-data payloads", () => {
  function contactWithNote(notes: string): DecryptedContact {
    return {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      user_id: "u",
      email: "erica@example.com",
      name: "Erica Roy",
      avatar_url: null,
      title: null,
      company: null,
      phone: null,
      website: null,
      card_image_url: null,
      address_line1: null,
      address_line2: null,
      city: null,
      region: null,
      postal_code: null,
      country: null,
      linkedin: null,
      twitter: null,
      relationship_summary: null,
      summary_generated_at: null,
      notes,
      source: "carddav",
      enriched_at: null,
      created_at: "2026-07-01T10:00:00.000Z",
      updated_at: "2026-07-01T10:00:00.000Z",
    } as DecryptedContact;
  }

  it("an inlined vCard whose NOTE contains & and < stays well-formed XML", () => {
    // A raw "&" inside <C:address-data> makes iOS's parser reject the whole
    // multistatus, so a single note with an ampersand would silently stall
    // an entire address-book sync.
    const note = 'Ben & Jerry <ben@example.com> said "hi" — 5 < 6';
    const vcard = contactToVCard(contactWithNote(note));
    expect(vcard).toContain("NOTE:");

    const escaped = xmlEscape(vcard);
    const body =
      MULTISTATUS_OPEN +
      responseBlock(
        "/api/public/carddav/x/contacts/y.vcf",
        `<C:address-data>${escaped}</C:address-data>`,
      ) +
      MULTISTATUS_CLOSE;

    // Between the address-data tags there must be no bare markup characters.
    const inner = body.match(/<C:address-data>([\s\S]*)<\/C:address-data>/)?.[1] ?? "";
    expect(inner).toContain("&amp;");
    expect(inner).toContain("&lt;");
    expect(inner.replace(/&(amp|lt|gt|quot|apos);/g, "")).not.toMatch(/[<>&]/);

    // And decoding the entities gives back the exact vCard the client needs.
    const decoded = inner
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
    expect(decoded).toBe(vcard);
  });
});

describe("responseBlock / davResponse", () => {
  it("escapes the href and defaults to a 200 propstat", () => {
    const block = responseBlock("/api/public/carddav/a&b/contacts/", '<D:getetag>"x"</D:getetag>');
    expect(block).toContain("<D:href>/api/public/carddav/a&amp;b/contacts/</D:href>");
    expect(block).toContain("<D:status>HTTP/1.1 200 OK</D:status>");
  });

  it("carries an explicit status when one is given", () => {
    expect(responseBlock("/x", "", "HTTP/1.1 404 Not Found")).toContain(
      "<D:status>HTTP/1.1 404 Not Found</D:status>",
    );
  });

  it("answers 207 with the DAV class header and merges extra headers", () => {
    const res = davResponse(MULTISTATUS_OPEN + MULTISTATUS_CLOSE, { "Cache-Control": "no-cache" });
    expect(res.status).toBe(207);
    expect(res.headers.get("DAV")).toBe("1, 3, addressbook");
    expect(res.headers.get("Content-Type")).toBe('application/xml; charset="utf-8"');
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });
});
