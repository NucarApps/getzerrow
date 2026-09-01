// Edge-branch companion to handlers.propfind-report.test.ts. Same harness
// (real Request/Response through the exported handlers, supabase fake,
// mocked encryption boundary); these tests pin the branches the main suite
// leaves open:
//
//   - PROPFIND resilience: missing Depth header, unknown/deep paths, and
//     request bodies (malformed XML or prop subsets) — iOS retries hard on
//     5xx, so every one of these must come back as a 2xx multistatus;
//   - REPORT addressbook-query (the full-collection enumeration branch);
//   - REPORT addressbook-multiget with group hrefs and with hrefs that do
//     not resolve (characterization: missing hrefs are OMITTED, not 404'd);
//   - sync-collection variants: sync-level infinite, address-data inline
//     vCards, group tombstones, and the nresults truncation behavior.
//
// Tests marked CHARACTERIZATION document current behavior (including RFC
// deviations) without endorsing it — see the comments on each.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import type { DecryptedContact } from "@/lib/sync/encrypted-reader";

const fake = makeSupabaseFake();
const decryptedRows = new Map<string, DecryptedContact>();
const getContactDecryptedMock = vi.fn(async (contactId: string) => ({
  row: decryptedRows.get(contactId) ?? null,
  error: null,
}));
const setContactEncryptedFieldsMock = vi.fn(async (_input: unknown) => ({
  error: null as string | null,
}));
const snapshotContactMock = vi.fn(async (..._args: unknown[]) => {});
const logInfoMock = vi.fn();

// CRITICAL: factories must not touch module-level consts at factory time
// (vi.mock hoisting) — every property access is deferred into method bodies.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));
vi.mock("@/lib/sync/encrypted-reader", () => ({
  getContactDecrypted: (contactId: string) => getContactDecryptedMock(contactId),
}));
vi.mock("@/lib/sync/encrypted-writer", () => ({
  setContactEncryptedFields: (input: unknown) => setContactEncryptedFieldsMock(input),
}));
vi.mock("@/lib/contacts/revisions.server", () => ({
  snapshotContact: (...args: unknown[]) => snapshotContactMock(...args),
}));
vi.mock("@/lib/log.server", () => ({
  logInfo: (...args: unknown[]) => logInfoMock(...args),
  logError: vi.fn(),
}));
vi.mock("@/lib/contacts/photos.server", () => ({
  saveContactPhoto: vi.fn(async () => {}),
  loadContactPhotoBytes: vi.fn(async () => null),
  sha256Hex: vi.fn(async () => "deadbeef"),
}));
vi.mock("@/lib/contacts/logo-photo.server", () => ({
  fetchChosenCompanyLogoBytes: vi.fn(async () => null),
  resolveCompanyLogoDomainForContact: vi.fn(async () => null),
  recordCompanyLogoHash: vi.fn(async () => {}),
}));
vi.mock("@/lib/contacts/label-resolve.server", () => ({
  resolveOrCreateCompanyLabel: vi.fn(async () => null),
}));
vi.mock("@/lib/companies/resolve.server", () => ({
  resolveContactCompany: vi.fn(async () => ({ companyId: null })),
}));
vi.mock("@/lib/contacts/auto-company-subgroups.functions", () => ({
  reconcileAutoParentsForContacts: vi.fn(async () => {}),
}));
vi.mock("@/lib/contacts/group-rules.functions", () => ({
  applyRulesForContact: vi.fn(async () => {}),
}));

import { handlePropfind, handleReport } from "./handlers.server";
import { contactETag, groupETag } from "./vcard";
import { xmlEscape, MULTISTATUS_OPEN, MULTISTATUS_CLOSE } from "./xml";

const USER = "user-1";
const EMAIL = "ios@example.com";
const BASE_URL = "http://localhost/api/public/carddav";

// UUID-shaped ids: the href routing regexes require [0-9a-f-]{36}.
const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEVER_EXISTED = "12345678-1234-4123-8123-123456789abc";
const FOREIGN_GROUP = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DELETED_GROUP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const G1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Recent timestamps — the sync-collection horizon rejects tokens older than
// 90 days, so fixtures must stay inside the window regardless of "today".
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const T1 = new Date(NOW - 3 * DAY).toISOString();
const T2 = new Date(NOW - 2 * DAY).toISOString();
const TG = new Date(NOW - 1 * DAY).toISOString();

function contactFixture(id: string, updatedAt: string): DecryptedContact {
  return {
    id,
    user_id: USER,
    email: `${id.slice(0, 8)}@example.com`,
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
    notes: null,
    source: "carddav",
    enriched_at: null,
    created_at: T1,
    updated_at: updatedAt,
  } as DecryptedContact;
}

function seedBase(): void {
  fake.seed("contacts", [
    { id: C1, user_id: USER, updated_at: T1 },
    { id: C2, user_id: USER, updated_at: T2 },
  ]);
  fake.seed("contact_groups", [
    {
      id: G1,
      user_id: USER,
      name: "Clients",
      updated_at: TG,
      carddav_uid: null,
      parent_group_id: null,
    },
  ]);
  fake.seed("carddav_settings", [
    {
      user_id: USER,
      resync_nonce: 0,
      group_name_style: "leaf",
      include_summary_in_notes: true,
      use_company_logo_fallback: false,
    },
  ]);
  fake.seed("carddav_tombstones", []);
  fake.seed("contact_phones", []);
  fake.seed("contact_emails", []);
  fake.seed("contact_group_members", [{ group_id: G1, contact_id: C1, user_id: USER }]);
  decryptedRows.set(C1, contactFixture(C1, T1));
  decryptedRows.set(C2, contactFixture(C2, T2));
}

function propfind(path: string, headers: Record<string, string> = {}, body?: string) {
  const req = new Request(`${BASE_URL}/${path}`, { method: "PROPFIND", headers, body });
  return handlePropfind(req, USER, EMAIL, path);
}

function report(body: string): Promise<Response> {
  const req = new Request(`${BASE_URL}/${EMAIL}/contacts/`, { method: "REPORT", body });
  return handleReport(req, USER, EMAIL);
}

function contactHref(id: string): string {
  return `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/${id}.vcf`;
}

function groupResourceHref(id: string): string {
  return `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/group-${id}.vcf`;
}

function multigetBody(hrefs: string[], props = "<D:getetag/><C:address-data/>"): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">' +
    `<D:prop>${props}</D:prop>` +
    hrefs.map((h) => `<D:href>${h}</D:href>`).join("") +
    "</C:addressbook-multiget>"
  );
}

function syncCollectionBody(
  opts: { token?: string; level?: string; props?: string; limit?: number } = {},
): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:sync-collection xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">' +
    `<D:sync-token>${opts.token ?? ""}</D:sync-token>` +
    `<D:sync-level>${opts.level ?? "1"}</D:sync-level>` +
    (opts.limit ? `<D:limit><D:nresults>${opts.limit}</D:nresults></D:limit>` : "") +
    `<D:prop>${opts.props ?? "<D:getetag/>"}</D:prop>` +
    "</D:sync-collection>"
  );
}

const syncToken = (userId: string, ms: number, seq: number) =>
  `urn:atzro:carddav:${userId}:${ms}:${seq}`;

const savedEncKey = process.env.EMAIL_ENC_KEY;

beforeEach(() => {
  fake.reset();
  decryptedRows.clear();
  vi.clearAllMocks();
  seedBase();
  process.env.EMAIL_ENC_KEY = "test-key";
});

afterEach(() => {
  if (savedEncKey === undefined) delete process.env.EMAIL_ENC_KEY;
  else process.env.EMAIL_ENC_KEY = savedEncKey;
});

describe("PROPFIND edge branches", () => {
  it("missing Depth header defaults to depth 0 (no addressbook enumeration)", async () => {
    const res = await propfind(`${EMAIL}`);
    expect(res.status).toBe(207);
    const body = await res.text();
    expect(body).toContain("<D:current-user-principal>");
    // Depth defaulted to 0: the addressbook collection block must be absent.
    expect(body).not.toContain("Atzro Contacts");
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
    // into an iOS retry loop. CHARACTERIZATION: body is ignored entirely.
    const res = await propfind(`${EMAIL}`, { depth: "0" }, "<propfind><not-closed");
    expect(res.status).toBe(207);
    const body = await res.text();
    expect(body).toContain("<D:current-user-principal>");
    expect(body).toContain("<C:addressbook-home-set>");
  });

  it("CHARACTERIZATION: requested-prop subsets are ignored — fixed prop set, no 404 propstat", async () => {
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

describe("REPORT addressbook-query", () => {
  it("enumerates every owned contact and group with inline vCards", async () => {
    const body =
      '<?xml version="1.0"?>' +
      '<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">' +
      "<D:prop><D:getetag/><C:address-data/></D:prop><C:filter/>" +
      "</C:addressbook-query>";
    const res = await report(body);
    expect(res.status).toBe(207);
    const text = await res.text();
    expect(text).toContain(contactHref(C1));
    expect(text).toContain(contactHref(C2));
    expect(text).toContain(groupResourceHref(G1));
    expect(text).toContain(xmlEscape(contactETag(C1, T1)));
    expect(text).toContain(xmlEscape(groupETag(G1, TG)));
    // address-data was requested → full vCards inline, group card included.
    expect(text).toContain("BEGIN:VCARD");
    expect(text).toContain("X-ADDRESSBOOKSERVER-KIND:group");
    expect(getContactDecryptedMock).toHaveBeenCalledTimes(2);
  });
});

describe("REPORT addressbook-multiget: groups and unresolvable hrefs", () => {
  it("returns the group vCard (kind + member urns) alongside contact blocks", async () => {
    const res = await report(multigetBody([contactHref(C1), groupResourceHref(G1)]));
    const text = await res.text();
    expect(text).toContain(contactHref(C1));
    expect(text).toContain(groupResourceHref(G1));
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
        groupResourceHref(G1),
        groupResourceHref(FOREIGN_GROUP), // not in contact_groups → ownership filter drops it
        `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/`, // collection itself
        `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/bogus.vcf`, // non-UUID
      ]),
    );
    expect(res.status).toBe(207);
    const text = await res.text();
    expect(text).toContain(groupResourceHref(G1));
    expect(text).not.toContain(FOREIGN_GROUP);
    expect(text).not.toContain("bogus.vcf");
  });

  it("CHARACTERIZATION: a href for a contact that never existed is silently omitted, not 404'd", async () => {
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
    expect(getContactDecryptedMock).toHaveBeenCalledTimes(1);
    expect(getContactDecryptedMock).toHaveBeenCalledWith(C1);
  });

  it("etag-only multiget (no address-data prop) omits the vCard payload", async () => {
    const res = await report(multigetBody([contactHref(C1)], "<D:getetag/>"));
    const text = await res.text();
    expect(text).toContain(xmlEscape(contactETag(C1, T1)));
    expect(text).not.toContain("address-data");
    expect(text).not.toContain("BEGIN:VCARD");
  });
});

describe("REPORT sync-collection edge branches", () => {
  it("accepts sync-level 'infinite' (iOS variant) as level 1", async () => {
    const res = await report(syncCollectionBody({ level: "infinite" }));
    expect(res.status).toBe(207);
    const text = await res.text();
    expect(text).toContain(contactHref(C1));
    expect(text).toContain(contactHref(C2));
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

  it("CHARACTERIZATION: nresults truncates the change list but the token still covers the full snapshot", async () => {
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
    expect(text).not.toContain("507"); // no insufficient-storage marker
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

  it("a completely empty REPORT body returns an empty multistatus with zero decrypts", async () => {
    const res = await report("");
    expect(res.status).toBe(207);
    expect(await res.text()).toBe(MULTISTATUS_OPEN + MULTISTATUS_CLOSE);
    expect(getContactDecryptedMock).not.toHaveBeenCalled();
  });
});
