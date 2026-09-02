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
//     filtering, idempotence when nothing changed, and 403 on foreign /
//     garbage / expired tokens so clients fall back to a full resync instead
//     of silently missing deletes;
//   - PROPFIND resilience: missing Depth header, unknown/deep paths, and
//     request bodies (malformed XML or prop subsets) — iOS retries hard on
//     5xx, so every one of these must come back as a 2xx multistatus;
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

  it("malformed XML body on PROPFIND is ignored — response is still a 207 multistatus", async () => {
    // The handler never parses the PROPFIND body, so broken XML cannot 500
    // into an iOS retry loop.
    const res = await propfind(`${EMAIL}`, { depth: "0" }, "<propfind><not-closed");
    expect(res.status).toBe(207);
    const body = await res.text();
    expect(body).toContain("<D:current-user-principal>");
    expect(body).toContain("<C:addressbook-home-set>");
  });

  // CHARACTERIZATION(carddav-prop-subset-ignored)
  it("requested-prop subsets are ignored — fixed prop set, no 404 propstat", async () => {
    // RFC 4918 wants un-requested props omitted and unknown props reported in
    // a 404 propstat. This server always returns its fixed prop set with a
    // single 200 propstat. Benign for iOS (it tolerates extra props), but a
    // documented deviation: unknown props are silently absent, not 404'd.
    const reqBody =
      '<?xml version="1.0"?>' +
      '<D:propfind xmlns:D="DAV:" xmlns:X="urn:example:custom">' +
      "<D:prop><D:displayname/><X:no-such-prop/></D:prop>" +
      "</D:propfind>";
    const res = await propfind(`${EMAIL}/contacts`, { depth: "0" }, reqBody);
    expect(res.status).toBe(207);
    const body = await res.text();
    // Props the client did NOT ask for are still returned...
    expect(body).toContain("<CS:getctag>");
    expect(body).toContain("<D:sync-token>");
    // ...and the unknown prop produces no 404 propstat block.
    expect(body).not.toContain("404");
    expect(body).not.toContain("no-such-prop");
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
  it("silently drops hrefs for contacts the authed user does not own", async () => {
    const res = await report(multigetBody([contactHref(C1), contactHref(FOREIGN)]));
    const body = await res.text();
    expect(body).toContain(contactHref(C1));
    expect(body).not.toContain(FOREIGN);
    // The foreign id must not even reach the decrypt boundary.
    expect(mocks.getContactDecrypted).toHaveBeenCalledTimes(1);
    expect(mocks.getContactDecrypted).toHaveBeenCalledWith(C1);
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

  it("drops unowned group hrefs and ignores hrefs that do not name a resource", async () => {
    const res = await report(
      multigetBody([
        groupHref(G1),
        groupHref(FOREIGN_GROUP), // not in contact_groups → ownership filter drops it
        `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/`, // collection itself
        `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/bogus.vcf`, // non-UUID
      ]),
    );
    expect(res.status).toBe(207);
    const text = await res.text();
    expect(text).toContain(groupHref(G1));
    expect(text).not.toContain(FOREIGN_GROUP);
    expect(text).not.toContain("bogus.vcf");
  });

  // CHARACTERIZATION(carddav-multiget-missing-href-omitted)
  it("a href for a contact that never existed is silently omitted, not 404'd", async () => {
    // RFC 6352 §8.7 says unresolvable multiget hrefs SHOULD come back as
    // 404 response blocks. This server filters by ownership first, so a
    // never-existed (or foreign) contact simply vanishes from the response.
    // iOS copes (it treats absence as "gone"), but this is a deviation worth
    // knowing about when debugging ghost contacts on devices.
    const res = await report(multigetBody([contactHref(C1), contactHref(NEVER_EXISTED)]));
    const text = await res.text();
    expect(text).toContain(contactHref(C1));
    expect(text).not.toContain(NEVER_EXISTED);
    expect(text).not.toContain("404");
    expect(mocks.getContactDecrypted).toHaveBeenCalledTimes(1);
    expect(mocks.getContactDecrypted).toHaveBeenCalledWith(C1);
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
  // CHARACTERIZATION(carddav-addressbook-query-filter-ignored): the
  // <C:filter> element is never parsed — every owned contact comes back
  // whatever the client asked to match.
  it("enumerates every owned contact and group with inline vCards, ignoring the filter", async () => {
    const body =
      '<?xml version="1.0"?>' +
      '<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">' +
      "<D:prop><D:getetag/><C:address-data/></D:prop>" +
      // A filter that should match nothing: both contacts still return.
      '<C:filter><C:prop-filter name="FN"><C:text-match>zzzz-no-such-name</C:text-match>' +
      "</C:prop-filter></C:filter>" +
      "</C:addressbook-query>";
    const res = await report(body);
    expect(res.status).toBe(207);
    const text = await res.text();
    expect(text).toContain(contactHref(C1));
    expect(text).toContain(contactHref(C2));
    expect(text).toContain(groupHref(G1));
    expect(text).toContain(xmlEscape(contactETag(C1, T1)));
    expect(text).toContain(xmlEscape(groupETag(G1, TG)));
    // address-data was requested → full vCards inline, group card included.
    expect(text).toContain("BEGIN:VCARD");
    expect(text).toContain("X-ADDRESSBOOKSERVER-KIND:group");
    expect(mocks.getContactDecrypted).toHaveBeenCalledTimes(2);
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

  // CHARACTERIZATION(carddav-nresults-token-covers-full-snapshot)
  it("nresults truncates the change list but the token still covers the full snapshot", async () => {
    // With <D:limit><D:nresults>1</D:nresults></D:limit>, only the oldest
    // changed contact is returned — but the sync-token is minted from the
    // CURRENT snapshot (newest updated_at overall). A client that honors the
    // token verbatim would never fetch C2. RFC 6578 §3.6 requires a
    // truncated response to carry a token consistent with what was actually
    // returned plus a 507 insufficient-storage marker. iOS does not send
    // nresults in practice, which is why this has not bitten; if a client
    // ever does, this is silent data loss on that device. Pinned here so a
    // future fix flips these assertions deliberately.
    const res = await report(syncCollectionBody({ limit: 1 }));
    expect(res.status).toBe(207);
    const text = await res.text();
    expect(text).toContain(contactHref(C1)); // oldest change, within limit
    expect(text).not.toContain(contactHref(C2)); // truncated away
    // No insufficient-storage marker. Matched as a status line rather than
    // a bare "507", which used to fail whenever the sync token's epoch
    // millis happened to contain those digits.
    expect(text).not.toMatch(/HTTP\/1\.1 507/);
    // Token claims the FULL snapshot (TG > C2's T2), skipping C2 forever.
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
