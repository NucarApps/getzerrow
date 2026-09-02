// Handler-level tests for the CardDAV read paths: OPTIONS, PROPFIND, and
// REPORT (addressbook-multiget + addressbook-query + sync-collection). These
// drive the real exported handlers with real Request/Response objects; the
// vcard/xml/group-name substrate stays REAL (it is unit-tested separately)
// while the Supabase client and the encryption boundary are replaced with
// fakes from __fixtures__/handler-harness.ts (read its header first).
//
// The contracts protected here:
//   - the iOS caching contract: the book CTag must move on every contact
//     edit, tombstone, and forced-resync bump, and stay stable otherwise —
//     iOS serves the whole address book from cache while the CTag holds;
//   - the probe guard: an unrecognized REPORT body must never fall through
//     to a full decrypted address-book dump;
//   - sync-collection token semantics (RFC 6578): strictly-greater
//     filtering, idempotence when nothing changed, 403 on foreign / garbage /
//     expired tokens so clients fall back to a full resync instead of
//     silently missing deletes, and a truncated run that reports 507 with a
//     token covering only what it actually sent;
//   - multiget href resolution: an href naming nothing comes back as a 404
//     block, and another user's contact is answered identically so the
//     report cannot be used to probe for ids;
//   - PROPFIND resilience and prop subsets: missing Depth header,
//     unknown/deep paths, malformed bodies — iOS retries hard on 5xx, so
//     every one must come back as a 2xx multistatus — plus the requested
//     prop subset, with a 404 propstat for props this server does not carry;
//   - the addressbook-query filter subset, and the fallback to the whole
//     collection for filter constructs it cannot evaluate;
//   - the flattened group-name styles iOS needs, resolved from a single
//     tree query rather than one per group.
//
// Tests marked CHARACTERIZATION document current behavior (including RFC
// deviations) without endorsing it — see the comments on each.

import { describe, it, expect, vi, beforeEach } from "vitest";
// MUST be the first non-vitest import: the `vi.mock` factories below are
// hoisted above the imports but only RUN when a mocked module is first
// resolved, which happens after this binding is assigned.
import * as H from "./__fixtures__/handler-harness";

vi.mock("@/integrations/supabase/client.server", () => H.mockSupabaseClient());
vi.mock("@/lib/sync/encrypted-reader", () => H.mockEncryptedReader());
vi.mock("@/lib/sync/encrypted-writer", () => H.mockEncryptedWriter());
vi.mock("@/lib/contacts/revisions.server", () => H.mockRevisions());
vi.mock("@/lib/log.server", () => H.mockLogServer());
vi.mock("@/lib/contacts/photos.server", () => H.mockPhotosServer());
vi.mock("@/lib/contacts/logo-photo.server", () => H.mockLogoPhoto());
vi.mock("@/lib/contacts/label-resolve.server", () => H.mockLabelResolve());
vi.mock("@/lib/companies/resolve.server", () => H.mockCompanyResolve());
vi.mock("@/lib/contacts/auto-company-subgroups.functions", () => H.mockAutoCompanySubgroups());
vi.mock("@/lib/contacts/group-rules.functions", () => H.mockGroupRules());
vi.mock("@/lib/google-contacts/mark-dirty.server", () => H.mockMarkDirty());

import { handleOptions } from "./handlers.server";
import { contactETag, groupETag } from "./vcard";
import { xmlEscape, MULTISTATUS_OPEN, MULTISTATUS_CLOSE } from "./xml";

const {
  fake,
  mocks,
  decryptedRows,
  FIXED_MS,
  FIXED_ISO,
  DAY,
  USER,
  EMAIL,
  C1,
  C2,
  C_NEW,
  FOREIGN,
  NEVER_EXISTED,
  DELETED,
  G1,
  G_CHILD,
  T1,
  T2,
  TG,
  contactHref,
  groupHref,
  bookHref,
  multigetBody,
  syncCollectionBody,
  syncToken,
  propfind,
  report,
  get,
  groupPath,
  readCTag,
  tokenFrom,
  seedBase,
  seedSettings,
} = H;

const FOREIGN_GROUP = FOREIGN;
const DELETED_GROUP = DELETED;

H.setupCardDavHarness();

/** Every `select` the group-tree loader issues (id,name,parent_group_id). */
function treeQueryCount(): number {
  return fake.calls.selects.filter(
    (s) => s.table === "contact_groups" && s.columns === "id,name,parent_group_id",
  ).length;
}

describe("OPTIONS", () => {
  it("advertises the DAV addressbook class and the supported methods", () => {
    const res = handleOptions();
    expect(res.status).toBe(200);
    expect(res.headers.get("DAV")).toBe("1, 3, addressbook");
    const allow = res.headers.get("Allow") ?? "";
    for (const method of ["OPTIONS", "GET", "PUT", "DELETE", "PROPFIND", "REPORT"]) {
      expect(allow).toContain(method);
    }
  });
});

describe("PROPFIND", () => {
  it("depth 0 on the principal returns the principal block without the addressbook", async () => {
    const res = await propfind("", { depth: "0" });
    expect(res.status).toBe(207);
    const body = await res.text();
    expect(body).toContain("<D:current-user-principal>");
    expect(body).toContain(`<D:href>/api/public/carddav/${encodeURIComponent(EMAIL)}/</D:href>`);
    expect(body).toContain("<C:addressbook-home-set>");
    // Depth 0 must not enumerate the addressbook collection itself.
    expect(body).not.toContain("Atzro Contacts");
  });

  it("depth 1 on the principal adds the addressbook collection block", async () => {
    const res = await propfind(`${EMAIL}`, { depth: "1" });
    const body = await res.text();
    expect(body).toContain("Atzro Contacts");
    expect(body).toContain("<C:addressbook/>");
    expect(body).toContain('version="3.0"');
  });

  it("missing Depth header defaults to depth 0 (no addressbook enumeration)", async () => {
    const res = await propfind(`${EMAIL}`);
    expect(res.status).toBe(207);
    const body = await res.text();
    expect(body).toContain("<D:current-user-principal>");
    expect(body).not.toContain("Atzro Contacts");
  });

  it("depth 0 on the addressbook returns CTag + sync-token but no member hrefs", async () => {
    const res = await propfind(`${EMAIL}/contacts`, { depth: "0" });
    const body = await res.text();
    expect(body).toContain("<CS:getctag>");
    expect(body).toContain("<D:sync-token>");
    expect(body).toContain("<D:sync-collection/>");
    expect(body).not.toContain(`${C1}.vcf`);
  });

  it("depth 1 on the addressbook lists every contact and group with its real ETag", async () => {
    const res = await propfind(`${EMAIL}/contacts`, { depth: "1" });
    const body = await res.text();
    // Per-resource ETags must be the exact values GET/PUT will use — iOS
    // compares them verbatim to decide what to re-fetch.
    expect(body).toContain(xmlEscape(contactETag(C1, T1)));
    expect(body).toContain(xmlEscape(contactETag(C2, T2)));
    expect(body).toContain(xmlEscape(groupETag(G1, TG)));
    expect(body).toContain(`${C1}.vcf`);
    expect(body).toContain(`group-${G1}.vcf`);
  });

  it("advertises the sync-token that a sync-collection REPORT would mint", async () => {
    const res = await propfind(`${EMAIL}/contacts`, { depth: "0" });
    const body = await res.text();
    // TG is the newest revision in the book and there are no tombstones.
    expect(body).toContain(
      `<D:sync-token>${xmlEscape(syncToken(USER, new Date(TG).getTime(), 0))}</D:sync-token>`,
    );
  });

  it("CTag is stable across identical polls (iOS caching contract)", async () => {
    const a = await readCTag();
    const b = await readCTag();
    expect(a).toBe(b);
  });

  it("CTag moves on contact update, tombstone, and resync_nonce bump", async () => {
    const baseline = await readCTag();

    // Contact edit bumps updated_at → CTag must move or iOS keeps its cache.
    fake.seed("contacts", [
      { id: C1, user_id: USER, updated_at: FIXED_ISO },
      { id: C2, user_id: USER, updated_at: T2 },
    ]);
    expect(await readCTag()).not.toBe(baseline);

    // Hard delete leaves only a tombstone behind; its seq must bump the CTag.
    seedBase();
    fake.seed("carddav_tombstones", [
      { user_id: USER, resource_type: "contact", resource_id: DELETED, sync_seq: 5 },
    ]);
    expect(await readCTag()).not.toBe(baseline);

    // "Force iPhone resync" increments resync_nonce with no data change.
    seedBase();
    seedSettings({ resync_nonce: 1 });
    expect(await readCTag()).not.toBe(baseline);
  });

  it("CTag moves when the group-name style changes (every group vCard is renamed)", async () => {
    const baseline = await readCTag();
    seedSettings({ group_name_style: "path_slash" });
    expect(await readCTag()).not.toBe(baseline);
  });

  it("PROPFIND on an unknown deeper path returns an empty multistatus, never a 500", async () => {
    // iOS should never PROPFIND a member .vcf, but a buggy client retry loop
    // must get a cheap 207, not an error it retries forever.
    const res = await propfind(`${EMAIL}/contacts/${C1}.vcf`, { depth: "0" });
    expect(res.status).toBe(207);
    expect(await res.text()).toBe(MULTISTATUS_OPEN + MULTISTATUS_CLOSE);

    const res2 = await propfind(`${EMAIL}/notcontacts`, { depth: "1" });
    expect(res2.status).toBe(207);
    expect(await res2.text()).toBe(MULTISTATUS_OPEN + MULTISTATUS_CLOSE);
  });

  it("malformed XML body on PROPFIND falls back to the full prop set, not a 500", async () => {
    // A body with no readable <D:prop> is treated as allprop, so broken XML
    // cannot 500 into an iOS retry loop.
    const res = await propfind(`${EMAIL}`, { depth: "0" }, "<propfind><not-closed");
    expect(res.status).toBe(207);
    const body = await res.text();
    expect(body).toContain("<D:current-user-principal>");
    expect(body).toContain("<C:addressbook-home-set>");
  });

  it("returns only the requested props, and 404s the ones it does not have", async () => {
    // RFC 4918 §9.1: un-requested props are omitted and props the resource
    // does not carry come back in their own 404 propstat, so the client can
    // tell "not supported here" from "supported but empty".
    const reqBody =
      '<?xml version="1.0"?>' +
      '<D:propfind xmlns:D="DAV:" xmlns:X="urn:example:custom">' +
      "<D:prop><D:displayname/><X:no-such-prop/></D:prop>" +
      "</D:propfind>";
    const res = await propfind(`${EMAIL}/contacts`, { depth: "0" }, reqBody);
    expect(res.status).toBe(207);
    const body = await res.text();
    expect(body).toContain(
      "<D:propstat><D:prop><D:displayname>Atzro Contacts</D:displayname></D:prop>" +
        "<D:status>HTTP/1.1 200 OK</D:status></D:propstat>",
    );
    expect(body).toContain(
      '<D:propstat><D:prop><x:no-such-prop xmlns:x="urn:example:custom"/></D:prop>' +
        "<D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>",
    );
    // Props the client did not ask for are gone.
    expect(body).not.toContain("<CS:getctag>");
    expect(body).not.toContain("<D:sync-token>");
    expect(body).not.toContain("<D:resourcetype>");
  });

  it("matches a requested prop by namespace, not by the prefix the client chose", async () => {
    // Clients bind DAV: to whatever prefix they like; a `displayname` in some
    // other namespace is a different property and must 404.
    const reqBody =
      '<?xml version="1.0"?>' +
      '<A:propfind xmlns:A="DAV:" xmlns:B="urn:example:other">' +
      "<A:prop><A:displayname/><B:displayname/></A:prop>" +
      "</A:propfind>";
    const body = await (await propfind(`${EMAIL}/contacts`, { depth: "0" }, reqBody)).text();
    expect(body).toContain("<D:displayname>Atzro Contacts</D:displayname>");
    expect(body).toContain('<x:displayname xmlns:x="urn:example:other"/>');
    expect(body).toContain("<D:status>HTTP/1.1 404 Not Found</D:status>");
  });

  it("applies the requested subset to every member block of a depth-1 listing", async () => {
    const reqBody =
      '<?xml version="1.0"?>' +
      '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>';
    const body = await (await propfind(`${EMAIL}/contacts`, { depth: "1" }, reqBody)).text();
    expect(body).toContain(xmlEscape(contactETag(C1, T1)));
    expect(body).toContain(xmlEscape(groupETag(G1, TG)));
    // getcontenttype was not asked for, so no block carries it.
    expect(body).not.toContain("getcontenttype");
    // The collection itself has no getetag → its own 404 propstat.
    expect(body).toContain("<D:status>HTTP/1.1 404 Not Found</D:status>");
  });

  it("an empty body still returns the full prop set (allprop)", async () => {
    const body = await (await propfind(`${EMAIL}/contacts`, { depth: "0" })).text();
    expect(body).toContain("<CS:getctag>");
    expect(body).toContain("<D:sync-token>");
    expect(body).not.toContain("404");
  });
});

describe("REPORT probe guard", () => {
  it("unknown REPORT body returns an empty multistatus with zero decrypt calls", async () => {
    // A malformed or probing REPORT must never force the expensive
    // full-decrypt path (handlers.server.ts routes it to an empty body).
    const res = await report('<?xml version="1.0"?><D:unknown-report xmlns:D="DAV:"/>');
    expect(res.status).toBe(207);
    expect(await res.text()).toBe(MULTISTATUS_OPEN + MULTISTATUS_CLOSE);
    expect(mocks.getContactDecrypted).not.toHaveBeenCalled();
  });

  it("a completely empty REPORT body returns an empty multistatus with zero decrypts", async () => {
    const res = await report("");
    expect(res.status).toBe(207);
    expect(await res.text()).toBe(MULTISTATUS_OPEN + MULTISTATUS_CLOSE);
    expect(mocks.getContactDecrypted).not.toHaveBeenCalled();
  });
});

describe("REPORT addressbook-multiget", () => {
  it("reports a href for another user's contact as 404 without decrypting it", async () => {
    const res = await report(multigetBody([contactHref(C1), contactHref(FOREIGN)]));
    const body = await res.text();
    expect(body).toContain(contactHref(C1));
    expect(body).toContain(
      `<D:response><D:href>${contactHref(FOREIGN)}</D:href>` +
        "<D:status>HTTP/1.1 404 Not Found</D:status></D:response>",
    );
    // The foreign id must not even reach the decrypt boundary.
    expect(mocks.getContactDecrypted).toHaveBeenCalledTimes(1);
    expect(mocks.getContactDecrypted).toHaveBeenCalledWith(C1);
  });

  it("answers a foreign contact exactly as it answers one that never existed", async () => {
    // The two responses must be indistinguishable apart from the href, or
    // the multiget becomes an oracle for "does this contact id exist on
    // some other account".
    const foreign = await (await report(multigetBody([contactHref(FOREIGN)]))).text();
    const missing = await (await report(multigetBody([contactHref(NEVER_EXISTED)]))).text();
    expect(foreign.replaceAll(FOREIGN, "<ID>")).toBe(missing.replaceAll(NEVER_EXISTED, "<ID>"));
  });

  it("returns a 404 response block for an owned contact whose decrypt comes back empty", async () => {
    decryptedRows.delete(C2);
    const res = await report(multigetBody([contactHref(C2)]));
    const body = await res.text();
    expect(body).toContain(contactHref(C2));
    expect(body).toContain("HTTP/1.1 404 Not Found");
  });

  it("includes the vCard payload and the current ETag when address-data is requested", async () => {
    const res = await report(multigetBody([contactHref(C1)]));
    const body = await res.text();
    expect(body).toContain(xmlEscape(contactETag(C1, T1)));
    expect(body).toContain("BEGIN:VCARD");
    expect(body).toContain(`UID:${C1}`);
  });

  it("returns the group vCard (kind + member urns) alongside contact blocks", async () => {
    const res = await report(multigetBody([contactHref(C1), groupHref(G1)]));
    const text = await res.text();
    expect(text).toContain(contactHref(C1));
    expect(text).toContain(groupHref(G1));
    expect(text).toContain(xmlEscape(groupETag(G1, TG)));
    expect(text).toContain("X-ADDRESSBOOKSERVER-KIND:group");
    // The member list references the contact UID and the UID falls back to
    // group-<id> when no carddav_uid is stored.
    expect(text).toContain(xmlEscape(`X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${C1}`));
    expect(text).toContain(`UID:group-${G1}`);
  });

  it("404s an unowned group href and any other .vcf that resolves to nothing", async () => {
    const bogus = `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/bogus.vcf`;
    const collection = `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/`;
    const res = await report(
      multigetBody([groupHref(G1), groupHref(FOREIGN_GROUP), collection, bogus]),
    );
    expect(res.status).toBe(207);
    const text = await res.text();
    expect(text).toContain(groupHref(G1));
    expect(text).toContain(
      `<D:response><D:href>${groupHref(FOREIGN_GROUP)}</D:href>` +
        "<D:status>HTTP/1.1 404 Not Found</D:status></D:response>",
    );
    expect(text).toContain(
      `<D:response><D:href>${bogus}</D:href>` +
        "<D:status>HTTP/1.1 404 Not Found</D:status></D:response>",
    );
    // The collection itself is not a member resource — it names something
    // that DOES exist, so it must not be reported as gone.
    expect(text).not.toContain(`<D:href>${collection}</D:href>`);
  });

  it("returns a 404 response block for a contact href that never existed", async () => {
    // RFC 6352 §8.7: an href in a multiget that names no resource comes back
    // as a 404 response block, so the client learns the resource is gone
    // instead of having to infer it from the href's absence.
    const res = await report(multigetBody([contactHref(C1), contactHref(NEVER_EXISTED)]));
    const text = await res.text();
    expect(text).toContain(contactHref(C1));
    expect(text).toContain(
      `<D:response><D:href>${contactHref(NEVER_EXISTED)}</D:href>` +
        "<D:status>HTTP/1.1 404 Not Found</D:status></D:response>",
    );
    expect(mocks.getContactDecrypted).toHaveBeenCalledTimes(1);
    expect(mocks.getContactDecrypted).toHaveBeenCalledWith(C1);
  });

  it("keeps response blocks in the order the client listed the hrefs", async () => {
    const text = await (
      await report(multigetBody([contactHref(NEVER_EXISTED), groupHref(G1), contactHref(C1)]))
    ).text();
    expect([
      text.indexOf(contactHref(NEVER_EXISTED)),
      text.indexOf(groupHref(G1)),
      text.indexOf(contactHref(C1)),
    ]).toStrictEqual(
      [
        text.indexOf(contactHref(NEVER_EXISTED)),
        text.indexOf(groupHref(G1)),
        text.indexOf(contactHref(C1)),
      ].sort((a, b) => a - b),
    );
  });

  it("etag-only multiget (no address-data prop) omits the vCard payload", async () => {
    const res = await report(multigetBody([contactHref(C1)], "<D:getetag/>"));
    const text = await res.text();
    expect(text).toContain(xmlEscape(contactETag(C1, T1)));
    expect(text).not.toContain("address-data");
    expect(text).not.toContain("BEGIN:VCARD");
  });
});

describe("REPORT addressbook-query", () => {
  /** An addressbook-query asking for etags + inline vCards, with `filterXml`
   * dropped in as the <C:filter> element (pass "" for no filter at all). */
  function queryBody(filterXml: string): string {
    return (
      '<?xml version="1.0"?>' +
      '<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">' +
      "<D:prop><D:getetag/><C:address-data/></D:prop>" +
      filterXml +
      "</C:addressbook-query>"
    );
  }

  /** The contact hrefs (not group hrefs) a query answered with. */
  async function matchedContacts(filterXml: string): Promise<string[]> {
    const text = await (await report(queryBody(filterXml))).text();
    return [C1, C2].filter((id) => text.includes(contactHref(id)));
  }

  beforeEach(() => {
    // Distinct names / addresses / numbers so a filter can tell them apart.
    decryptedRows.set(
      C1,
      H.contactFixture(C1, T1, { name: "Erica Roy", email: "erica@acme.example" }),
    );
    decryptedRows.set(
      C2,
      H.contactFixture(C2, T2, { name: "Jordan Baker", email: "jordan@northwind.example" }),
    );
    fake.seed("contact_emails", [
      {
        contact_id: C1,
        user_id: USER,
        label: "work",
        address: "erica@acme.example",
        is_primary: true,
        position: 0,
      },
      {
        contact_id: C2,
        user_id: USER,
        label: "work",
        address: "jordan@northwind.example",
        is_primary: true,
        position: 0,
      },
    ]);
    fake.seed("contact_phones", [
      {
        contact_id: C1,
        user_id: USER,
        label: "mobile",
        number: "+1 555 0101",
        is_primary: true,
        position: 0,
      },
      {
        contact_id: C2,
        user_id: USER,
        label: "work",
        number: "+1 555 0202",
        is_primary: true,
        position: 0,
      },
    ]);
  });

  it("enumerates every owned contact and group with inline vCards when no filter is sent", async () => {
    const res = await report(queryBody(""));
    expect(res.status).toBe(207);
    const text = await res.text();
    expect(text).toContain(contactHref(C1));
    expect(text).toContain(contactHref(C2));
    expect(text).toContain(groupHref(G1));
    expect(text).toContain(xmlEscape(contactETag(C1, T1)));
    expect(text).toContain(xmlEscape(groupETag(G1, TG)));
    expect(text).toContain("BEGIN:VCARD");
    expect(text).toContain("X-ADDRESSBOOKSERVER-KIND:group");
  });

  it("returns only the contacts a FN text-match selects", async () => {
    expect(
      await matchedContacts(
        '<C:filter><C:prop-filter name="FN">' +
          "<C:text-match>jordan</C:text-match>" +
          "</C:prop-filter></C:filter>",
      ),
    ).toStrictEqual([C2]);
  });

  it("returns nothing at all when the filter matches nothing", async () => {
    const text = await (
      await report(
        queryBody(
          '<C:filter><C:prop-filter name="FN">' +
            "<C:text-match>zzzz-no-such-name</C:text-match>" +
            "</C:prop-filter></C:filter>",
        ),
      )
    ).text();
    expect(text).toBe(MULTISTATUS_OPEN + MULTISTATUS_CLOSE);
  });

  it("honours every match-type, defaulting to contains", async () => {
    const fn = (attrs: string, value: string) =>
      `<C:filter><C:prop-filter name="FN"><C:text-match ${attrs}>${value}</C:text-match></C:prop-filter></C:filter>`;
    expect(await matchedContacts(fn('match-type="equals"', "Erica Roy"))).toStrictEqual([C1]);
    expect(await matchedContacts(fn('match-type="equals"', "Erica"))).toStrictEqual([]);
    expect(await matchedContacts(fn('match-type="starts-with"', "Erica"))).toStrictEqual([C1]);
    expect(await matchedContacts(fn('match-type="starts-with"', "Roy"))).toStrictEqual([]);
    expect(await matchedContacts(fn('match-type="ends-with"', "Baker"))).toStrictEqual([C2]);
    expect(await matchedContacts(fn('match-type="contains"', "a R"))).toStrictEqual([C1]);
    // No match-type attribute at all is "contains".
    expect(await matchedContacts(fn("", "rica"))).toStrictEqual([C1]);
  });

  it("matches case-insensitively, per the default unicode-casemap collation", async () => {
    expect(
      await matchedContacts(
        '<C:filter><C:prop-filter name="FN"><C:text-match>ERICA</C:text-match></C:prop-filter></C:filter>',
      ),
    ).toStrictEqual([C1]);
  });

  it("inverts a text-match carrying negate-condition=yes", async () => {
    expect(
      await matchedContacts(
        '<C:filter><C:prop-filter name="FN">' +
          '<C:text-match negate-condition="yes">Erica</C:text-match>' +
          "</C:prop-filter></C:filter>",
      ),
    ).toStrictEqual([C2]);
  });

  it("filters on EMAIL, TEL and UID as well as FN", async () => {
    expect(
      await matchedContacts(
        '<C:filter><C:prop-filter name="EMAIL"><C:text-match>northwind</C:text-match></C:prop-filter></C:filter>',
      ),
    ).toStrictEqual([C2]);
    expect(
      await matchedContacts(
        '<C:filter><C:prop-filter name="TEL"><C:text-match>0101</C:text-match></C:prop-filter></C:filter>',
      ),
    ).toStrictEqual([C1]);
    expect(
      await matchedContacts(
        `<C:filter><C:prop-filter name="UID"><C:text-match match-type="equals">${C2}</C:text-match></C:prop-filter></C:filter>`,
      ),
    ).toStrictEqual([C2]);
  });

  it("combines prop-filters with the filter's test attribute (anyof by default)", async () => {
    const two = (test: string) =>
      `<C:filter${test}>` +
      '<C:prop-filter name="FN"><C:text-match>Erica</C:text-match></C:prop-filter>' +
      '<C:prop-filter name="EMAIL"><C:text-match>northwind</C:text-match></C:prop-filter>' +
      "</C:filter>";
    expect(await matchedContacts(two(""))).toStrictEqual([C1, C2]);
    expect(await matchedContacts(two(' test="anyof"'))).toStrictEqual([C1, C2]);
    expect(await matchedContacts(two(' test="allof"'))).toStrictEqual([]);

    const bothOnC1 =
      '<C:filter test="allof">' +
      '<C:prop-filter name="FN"><C:text-match>Erica</C:text-match></C:prop-filter>' +
      '<C:prop-filter name="EMAIL"><C:text-match>acme</C:text-match></C:prop-filter>' +
      "</C:filter>";
    expect(await matchedContacts(bothOnC1)).toStrictEqual([C1]);
  });

  it("matches group cards on their rendered FN and skips them for contact-only props", async () => {
    const byName = await (
      await report(
        queryBody(
          '<C:filter><C:prop-filter name="FN"><C:text-match>Clients</C:text-match></C:prop-filter></C:filter>',
        ),
      )
    ).text();
    expect(byName).toContain(groupHref(G1));
    expect(byName).not.toContain(contactHref(C1));

    // A group card carries no TEL, so a TEL filter can never select it.
    const byTel = await (
      await report(
        queryBody(
          '<C:filter><C:prop-filter name="TEL"><C:text-match>0101</C:text-match></C:prop-filter></C:filter>',
        ),
      )
    ).text();
    expect(byTel).not.toContain(groupHref(G1));
  });

  it("does not fetch a photo for a contact the filter excluded", async () => {
    // The photo load can reach out for a company logo; a filtered-out card
    // must not pay for one.
    seedSettings({ use_company_logo_fallback: true, photo_priority: "personal_first" });
    await report(
      queryBody(
        '<C:filter><C:prop-filter name="FN"><C:text-match>Erica</C:text-match></C:prop-filter></C:filter>',
      ),
    );
    expect(mocks.resolveCompanyLogoDomainForContact).toHaveBeenCalledTimes(1);
  });

  // CHARACTERIZATION(carddav-addressbook-query-filter-ignored)
  it("falls back to the whole collection for filter constructs it cannot evaluate", async () => {
    // Only prop-filter/text-match on FN, EMAIL, TEL and UID are evaluated.
    // Anything else — is-not-defined, param-filter, another property name, a
    // non-default collation — is answered with the unfiltered collection,
    // which is a superset the client can narrow itself. Silent, but never
    // wrong in the dangerous direction; see the register entry.
    const unsupported = [
      '<C:filter><C:prop-filter name="NICKNAME"><C:text-match>x</C:text-match></C:prop-filter></C:filter>',
      '<C:filter><C:prop-filter name="EMAIL"><C:is-not-defined/></C:prop-filter></C:filter>',
      '<C:filter><C:prop-filter name="TEL"><C:param-filter name="TYPE">' +
        "<C:text-match>WORK</C:text-match></C:param-filter></C:prop-filter></C:filter>",
      '<C:filter><C:prop-filter name="FN">' +
        '<C:text-match collation="i;octet">Erica</C:text-match></C:prop-filter></C:filter>',
      '<C:filter><C:prop-filter name="FN">' +
        '<C:text-match match-type="regex">Erica</C:text-match></C:prop-filter></C:filter>',
    ];
    for (const filterXml of unsupported) {
      expect(await matchedContacts(filterXml), filterXml).toStrictEqual([C1, C2]);
    }
  });
});

describe("REPORT sync-collection", () => {
  it("rejects an unsupported sync-level with 400 valid-sync-token", async () => {
    const res = await report(syncCollectionBody({ level: "2" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("valid-sync-token");
  });

  it("accepts sync-level 'infinite' (iOS variant) as level 1", async () => {
    const res = await report(syncCollectionBody({ level: "infinite" }));
    expect(res.status).toBe(207);
    const text = await res.text();
    expect(text).toContain(contactHref(C1));
    expect(text).toContain(contactHref(C2));
  });

  it("rejects a garbage token with 403 (client falls back to full resync)", async () => {
    const res = await report(syncCollectionBody({ token: "http://other-server/ns/sync/17" }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("valid-sync-token");
  });

  it("rejects a well-formed token minted for a different user with 403", async () => {
    const res = await report(syncCollectionBody({ token: syncToken("someone-else", FIXED_MS, 0) }));
    expect(res.status).toBe(403);
  });

  it("rejects a token older than the 90-day tombstone horizon with 403", async () => {
    // Tombstones are pruned after 90 days, so an older token could silently
    // miss deletes — the RFC fallback is forcing a full resync via 403.
    const res = await report(
      syncCollectionBody({ token: syncToken(USER, FIXED_MS - 91 * DAY, 0) }),
    );
    expect(res.status).toBe(403);
  });

  it("initial sync (empty token) lists everything and mints a token from the latest snapshot", async () => {
    const res = await report(syncCollectionBody());
    expect(res.status).toBe(207);
    const body = await res.text();
    expect(body).toContain(contactHref(C1));
    expect(body).toContain(contactHref(C2));
    expect(body).toContain(`group-${G1}.vcf`);
    // Token encodes the newest updated_at (the group, TG) and tombstone seq 0.
    expect(body).toContain(xmlEscape(syncToken(USER, new Date(TG).getTime(), 0)));
  });

  it("replaying the token it just minted returns an empty delta and the same token", async () => {
    // Idempotence is what stops an iPhone from re-downloading the whole book
    // on every poll: nothing changed, so nothing comes back and the client's
    // stored token stays valid.
    const first = tokenFrom(await (await report(syncCollectionBody())).text());
    const res = await report(syncCollectionBody({ token: first }));
    expect(res.status).toBe(207);
    const body = await res.text();
    expect(body).not.toContain(".vcf");
    expect(body).toBe(
      MULTISTATUS_OPEN + `<D:sync-token>${xmlEscape(first)}</D:sync-token>` + MULTISTATUS_CLOSE,
    );
  });

  it("a group-only change comes back alone, with the token advanced past it", async () => {
    const first = tokenFrom(await (await report(syncCollectionBody())).text());
    // A rename (or a membership change, which the DB trigger stamps the same
    // way) moves only contact_groups.updated_at.
    fake.seed("contact_groups", [
      {
        id: G1,
        user_id: USER,
        name: "Renamed Clients",
        updated_at: FIXED_ISO,
        carddav_uid: null,
        parent_group_id: null,
      },
    ]);

    const res = await report(syncCollectionBody({ token: first }));
    const body = await res.text();
    expect(body).toContain(`group-${G1}.vcf`);
    expect(body).not.toContain(`${C1}.vcf`);
    expect(body).not.toContain(`${C2}.vcf`);
    expect(body).toContain(xmlEscape(syncToken(USER, FIXED_MS, 0)));
  });

  it("incremental sync filters strictly-greater and reports tombstones as 404 blocks", async () => {
    fake.seed("carddav_tombstones", [
      { user_id: USER, resource_type: "contact", resource_id: DELETED, sync_seq: 3 },
    ]);
    // Token cut exactly at C1's updated_at: strictly-greater means C1 must
    // NOT be resent (equal is "already seen"), while C2 and the group are.
    const res = await report(
      syncCollectionBody({ token: syncToken(USER, new Date(T1).getTime(), 0) }),
    );
    const body = await res.text();
    expect(body).not.toContain(`${C1}.vcf`);
    expect(body).toContain(contactHref(C2));
    expect(body).toContain(`group-${G1}.vcf`);
    // The tombstoned contact appears as a 404 status block so iOS deletes it.
    expect(body).toContain(`${DELETED}.vcf`);
    expect(body).toContain("HTTP/1.1 404 Not Found");
  });

  it("inlines full vCards when the sync-collection prop list asks for address-data", async () => {
    const res = await report(syncCollectionBody({ props: "<D:getetag/><C:address-data/>" }));
    expect(res.status).toBe(207);
    const text = await res.text();
    expect(text).toContain("BEGIN:VCARD");
    expect(text).toContain(`UID:${C1}`);
    expect(text).toContain("X-ADDRESSBOOKSERVER-KIND:group");
  });

  it("reports a group tombstone as a 404 block under the group- href", async () => {
    fake.seed("carddav_tombstones", [
      { user_id: USER, resource_type: "group", resource_id: DELETED_GROUP, sync_seq: 3 },
    ]);
    const res = await report(syncCollectionBody());
    const text = await res.text();
    expect(text).toContain(`group-${DELETED_GROUP}.vcf`);
    expect(text).toContain("HTTP/1.1 404 Not Found");
    // The minted token advances past the tombstone seq so the delete is not
    // replayed on the next incremental sync.
    expect(text).toContain(xmlEscape(syncToken(USER, new Date(TG).getTime(), 3)));
  });

  it("nresults truncates the change list, marks it 507, and mints a matching token", async () => {
    // RFC 6578 §3.6: a truncated response carries a 507 response block for
    // the collection and a sync-token consistent with what was actually
    // returned. Minting the full-snapshot token here would skip C2 and the
    // group on that device forever.
    const res = await report(syncCollectionBody({ limit: 1 }));
    expect(res.status).toBe(207);
    const text = await res.text();
    expect(text).toContain(contactHref(C1)); // oldest change, within limit
    expect(text).not.toContain(contactHref(C2));
    expect(text).not.toContain(`group-${G1}.vcf`);
    expect(text).toContain(
      `<D:response><D:href>${bookHref()}</D:href>` +
        "<D:status>HTTP/1.1 507 Insufficient Storage</D:status>" +
        "<D:error><D:number-of-matches-within-limits/></D:error></D:response>",
    );
    // Token covers exactly the one change that was reported.
    expect(text).toContain(xmlEscape(syncToken(USER, new Date(T1).getTime(), 0)));
  });

  it("spends the nresults budget across all three change streams, not per table", async () => {
    // The limit used to be pushed into each query separately, so nresults=1
    // could return one contact AND one group AND one tombstone.
    fake.seed("carddav_tombstones", [
      { user_id: USER, resource_type: "contact", resource_id: DELETED, sync_seq: 3 },
    ]);
    const text = await (await report(syncCollectionBody({ limit: 1 }))).text();
    expect(text.match(/<D:href>/g)).toHaveLength(2); // one change + the 507 block
    expect(text).toContain(contactHref(C1));
    expect(text).not.toContain(`${DELETED}.vcf`);
  });

  it("a client honouring the truncated token gets the rest, losing nothing", async () => {
    fake.seed("carddav_tombstones", [
      { user_id: USER, resource_type: "contact", resource_id: DELETED, sync_seq: 3 },
    ]);
    const seen: string[] = [];
    let token = "";
    for (let round = 0; round < 6; round++) {
      const text = await (await report(syncCollectionBody({ token, limit: 1 }))).text();
      for (const m of text.matchAll(/<D:href>([^<]*\.vcf)<\/D:href>/g)) seen.push(m[1]!);
      const next = tokenFrom(text);
      if (next === token) break;
      token = next;
    }
    expect(seen).toStrictEqual([
      contactHref(C1),
      contactHref(C2),
      groupHref(G1),
      contactHref(DELETED),
    ]);
    // And the token it settles on is the one a full sync would have minted.
    expect(token).toBe(syncToken(USER, new Date(TG).getTime(), 3));
  });

  it("never cuts between two changes sharing an updated_at, which the token could not express", async () => {
    // The token carries a millisecond and the next request asks for rows
    // strictly greater than it, so a cut between two rows stamped the same
    // millisecond would lose the second one for good.
    fake.seed("contacts", [
      { id: C1, user_id: USER, updated_at: T1 },
      { id: C2, user_id: USER, updated_at: T2 },
      { id: C_NEW, user_id: USER, updated_at: T2 },
    ]);
    fake.seed("contact_groups", []);
    decryptedRows.set(C_NEW, H.contactFixture(C_NEW, T2));

    const first = await (await report(syncCollectionBody({ limit: 1 }))).text();
    expect(first).toContain(contactHref(C1));
    const second = await (
      await report(syncCollectionBody({ token: tokenFrom(first), limit: 1 }))
    ).text();
    // The whole T2 block comes back together even though it overruns the
    // budget of one.
    expect(second).toContain(contactHref(C2));
    expect(second).toContain(contactHref(C_NEW));
    expect(tokenFrom(second)).toBe(syncToken(USER, new Date(T2).getTime(), 0));
  });

  it("an untruncated response carries no 507 block", async () => {
    const text = await (await report(syncCollectionBody({ limit: 50 }))).text();
    expect(text).toContain(contactHref(C1));
    expect(text).toContain(contactHref(C2));
    expect(text).not.toMatch(/HTTP\/1\.1 507/);
    expect(text).toContain(xmlEscape(syncToken(USER, new Date(TG).getTime(), 0)));
  });

  it("a non-XML body that merely mentions sync-collection degrades to an initial sync, not a 500", async () => {
    // The REPORT router is substring-based. Garbage containing the phrase
    // parses to an empty token → full etag-only listing. Expensive but safe:
    // 207, no error, and no vCard payloads since address-data was absent.
    const res = await report("please sync-collection kthx");
    expect(res.status).toBe(207);
    const text = await res.text();
    expect(text).toContain(contactHref(C1));
    expect(text).toContain(contactHref(C2));
    expect(text).not.toContain("BEGIN:VCARD");
  });
});

describe("group display names", () => {
  // iOS Contacts renders a flat group list, so nested Atzro groups get their
  // path flattened per the user's group_name_style.
  beforeEach(() => {
    fake.seed("contact_groups", [
      {
        id: G1,
        user_id: USER,
        name: "Factory",
        updated_at: TG,
        carddav_uid: null,
        parent_group_id: null,
      },
      {
        id: G_CHILD,
        user_id: USER,
        name: "Toyota",
        updated_at: TG,
        carddav_uid: null,
        parent_group_id: G1,
      },
    ]);
  });

  it("path_slash flattens a child group to 'Parent / Child' on GET", async () => {
    seedSettings({ group_name_style: "path_slash" });
    const res = await get(groupPath(G_CHILD));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("FN:Factory / Toyota");
  });

  it("path_dash uses the dash separator", async () => {
    seedSettings({ group_name_style: "path_dash" });
    const res = await get(groupPath(G_CHILD));
    expect(await res.text()).toContain("FN:Factory - Toyota");
  });

  it("leaf keeps the group's own name and never loads the tree", async () => {
    seedSettings({ group_name_style: "leaf" });
    const res = await get(groupPath(G_CHILD));
    expect(await res.text()).toContain("FN:Toyota");
    expect(treeQueryCount()).toBe(0);
  });

  it("a whole-collection REPORT resolves every path from ONE tree query", async () => {
    // The lookup used to re-query per group, which is O(n²) over a big
    // address book on every iPhone sync.
    seedSettings({ group_name_style: "path_slash" });
    const body =
      '<?xml version="1.0"?>' +
      '<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">' +
      "<D:prop><D:getetag/><C:address-data/></D:prop>" +
      "</C:addressbook-query>";
    const text = await (await report(body)).text();
    expect(text).toContain("FN:Factory / Toyota");
    expect(text).toContain("FN:Factory");
    expect(treeQueryCount()).toBe(1);
  });

  it("a sync-collection listing resolves every path from ONE tree query", async () => {
    seedSettings({ group_name_style: "path_slash" });
    const text = await (
      await report(syncCollectionBody({ props: "<D:getetag/><C:address-data/>" }))
    ).text();
    expect(text).toContain("FN:Factory / Toyota");
    expect(treeQueryCount()).toBe(1);
  });
});
