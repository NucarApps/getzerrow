// Handler-level tests for the CardDAV read paths: OPTIONS, PROPFIND, and
// REPORT (addressbook-multiget + sync-collection). These drive the real
// exported handlers with real Request/Response objects; the vcard/xml/
// group-name substrate stays REAL (it is unit-tested separately) while the
// Supabase client and the encryption boundary are replaced with fakes.
//
// The contracts protected here:
//   - the iOS caching contract: the book CTag must move on every contact
//     edit, tombstone, and forced-resync bump, and stay stable otherwise —
//     iOS serves the whole address book from cache while the CTag holds;
//   - the probe guard: an unrecognized REPORT body must never fall through
//     to a full decrypted address-book dump;
//   - sync-collection token semantics (RFC 6578): strictly-greater
//     filtering, 403 on foreign/garbage/expired tokens so clients fall back
//     to a full resync instead of silently missing deletes.

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

import { handleOptions, handlePropfind, handleReport } from "./handlers.server";
import { contactETag, groupETag } from "./vcard";
import { xmlEscape, MULTISTATUS_OPEN, MULTISTATUS_CLOSE } from "./xml";

const USER = "user-1";
const EMAIL = "ios@example.com";
const BASE_URL = "http://localhost/api/public/carddav";

// UUID-shaped ids: the href routing regexes require [0-9a-f-]{36}.
const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FOREIGN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DELETED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
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
  // use_company_logo_fallback=false keeps the REPORT path off the live
  // company-logo fetch; group_name_style=leaf keeps the tree lookup out.
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
  fake.seed("contact_group_members", []);
  decryptedRows.set(C1, contactFixture(C1, T1));
  decryptedRows.set(C2, contactFixture(C2, T2));
}

function propfind(path: string, depth: string): Promise<Response> {
  const req = new Request(`${BASE_URL}/${path}`, { method: "PROPFIND", headers: { depth } });
  return handlePropfind(req, USER, EMAIL, path);
}

function report(body: string): Promise<Response> {
  const req = new Request(`${BASE_URL}/${EMAIL}/contacts/`, { method: "REPORT", body });
  return handleReport(req, USER, EMAIL);
}

function contactHref(id: string): string {
  return `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/${id}.vcf`;
}

function multigetBody(hrefs: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">' +
    "<D:prop><D:getetag/><C:address-data/></D:prop>" +
    hrefs.map((h) => `<D:href>${h}</D:href>`).join("") +
    "</C:addressbook-multiget>"
  );
}

function syncCollectionBody(opts: { token?: string; level?: string } = {}): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:sync-collection xmlns:D="DAV:">' +
    `<D:sync-token>${opts.token ?? ""}</D:sync-token>` +
    `<D:sync-level>${opts.level ?? "1"}</D:sync-level>` +
    "<D:prop><D:getetag/></D:prop>" +
    "</D:sync-collection>"
  );
}

async function extractCTag(): Promise<string> {
  const res = await propfind(`${EMAIL}/contacts`, "0");
  const body = await res.text();
  const m = body.match(/<CS:getctag>([\s\S]*?)<\/CS:getctag>/);
  if (!m) throw new Error(`no CTag in: ${body}`);
  return m[1];
}

const savedEncKey = process.env.EMAIL_ENC_KEY;

beforeEach(() => {
  fake.reset();
  decryptedRows.clear();
  vi.clearAllMocks();
  seedBase();
  // The encryption boundary is mocked; the key is set defensively so a mock
  // gap would fail loudly in the RPC layer instead of on a missing env var.
  process.env.EMAIL_ENC_KEY = "test-key";
});

afterEach(() => {
  if (savedEncKey === undefined) delete process.env.EMAIL_ENC_KEY;
  else process.env.EMAIL_ENC_KEY = savedEncKey;
});

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
    const res = await propfind("", "0");
    expect(res.status).toBe(207);
    const body = await res.text();
    expect(body).toContain("<D:current-user-principal>");
    expect(body).toContain(`<D:href>/api/public/carddav/${encodeURIComponent(EMAIL)}/</D:href>`);
    expect(body).toContain("<C:addressbook-home-set>");
    // Depth 0 must not enumerate the addressbook collection itself.
    expect(body).not.toContain("Zerrow Contacts");
  });

  it("depth 1 on the principal adds the addressbook collection block", async () => {
    const res = await propfind(`${EMAIL}`, "1");
    const body = await res.text();
    expect(body).toContain("Zerrow Contacts");
    expect(body).toContain("<C:addressbook/>");
    expect(body).toContain('version="3.0"');
  });

  it("depth 0 on the addressbook returns CTag + sync-token but no member hrefs", async () => {
    const res = await propfind(`${EMAIL}/contacts`, "0");
    const body = await res.text();
    expect(body).toContain("<CS:getctag>");
    expect(body).toContain("<D:sync-token>");
    expect(body).toContain("<D:sync-collection/>");
    expect(body).not.toContain(`${C1}.vcf`);
  });

  it("depth 1 on the addressbook lists every contact and group with its real ETag", async () => {
    const res = await propfind(`${EMAIL}/contacts`, "1");
    const body = await res.text();
    // Per-resource ETags must be the exact values GET/PUT will use — iOS
    // compares them verbatim to decide what to re-fetch.
    expect(body).toContain(xmlEscape(contactETag(C1, T1)));
    expect(body).toContain(xmlEscape(contactETag(C2, T2)));
    expect(body).toContain(xmlEscape(groupETag(G1, TG)));
    expect(body).toContain(`${C1}.vcf`);
    expect(body).toContain(`group-${G1}.vcf`);
  });

  it("CTag is stable across identical polls (iOS caching contract)", async () => {
    const a = await extractCTag();
    const b = await extractCTag();
    expect(a).toBe(b);
  });

  it("CTag moves on contact update, tombstone, and resync_nonce bump", async () => {
    const baseline = await extractCTag();

    // Contact edit bumps updated_at → CTag must move or iOS keeps its cache.
    fake.seed("contacts", [
      { id: C1, user_id: USER, updated_at: new Date(NOW).toISOString() },
      { id: C2, user_id: USER, updated_at: T2 },
    ]);
    const afterUpdate = await extractCTag();
    expect(afterUpdate).not.toBe(baseline);

    // Hard delete leaves only a tombstone behind; its seq must bump the CTag.
    seedBase();
    fake.seed("carddav_tombstones", [
      { user_id: USER, resource_type: "contact", resource_id: DELETED, sync_seq: 5 },
    ]);
    const afterTombstone = await extractCTag();
    expect(afterTombstone).not.toBe(baseline);

    // "Force iPhone resync" increments resync_nonce with no data change.
    seedBase();
    fake.seed("carddav_settings", [
      {
        user_id: USER,
        resync_nonce: 1,
        group_name_style: "leaf",
        include_summary_in_notes: true,
        use_company_logo_fallback: false,
      },
    ]);
    const afterNonce = await extractCTag();
    expect(afterNonce).not.toBe(baseline);
  });
});

describe("REPORT probe guard", () => {
  it("unknown REPORT body returns an empty multistatus with zero decrypt calls", async () => {
    // A malformed or probing REPORT must never force the expensive
    // full-decrypt path (handlers.server.ts routes it to an empty body).
    const res = await report('<?xml version="1.0"?><D:unknown-report xmlns:D="DAV:"/>');
    expect(res.status).toBe(207);
    expect(await res.text()).toBe(MULTISTATUS_OPEN + MULTISTATUS_CLOSE);
    expect(getContactDecryptedMock).not.toHaveBeenCalled();
  });
});

describe("REPORT addressbook-multiget", () => {
  it("silently drops hrefs for contacts the authed user does not own", async () => {
    const res = await report(multigetBody([contactHref(C1), contactHref(FOREIGN)]));
    const body = await res.text();
    expect(body).toContain(contactHref(C1));
    expect(body).not.toContain(FOREIGN);
    // The foreign id must not even reach the decrypt boundary.
    expect(getContactDecryptedMock).toHaveBeenCalledTimes(1);
    expect(getContactDecryptedMock).toHaveBeenCalledWith(C1);
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
});

describe("REPORT sync-collection", () => {
  const token = (userId: string, ms: number, seq: number) =>
    `urn:zerrow:carddav:${userId}:${ms}:${seq}`;

  it("rejects an unsupported sync-level with 400 valid-sync-token", async () => {
    const res = await report(syncCollectionBody({ level: "2" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("valid-sync-token");
  });

  it("rejects a garbage token with 403 (client falls back to full resync)", async () => {
    const res = await report(syncCollectionBody({ token: "http://other-server/ns/sync/17" }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("valid-sync-token");
  });

  it("rejects a well-formed token minted for a different user with 403", async () => {
    const res = await report(syncCollectionBody({ token: token("someone-else", NOW, 0) }));
    expect(res.status).toBe(403);
  });

  it("rejects a token older than the 90-day tombstone horizon with 403", async () => {
    // Tombstones are pruned after 90 days, so an older token could silently
    // miss deletes — the RFC fallback is forcing a full resync via 403.
    const res = await report(syncCollectionBody({ token: token(USER, NOW - 91 * DAY, 0) }));
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
    expect(body).toContain(xmlEscape(token(USER, new Date(TG).getTime(), 0)));
  });

  it("incremental sync filters strictly-greater and reports tombstones as 404 blocks", async () => {
    fake.seed("carddav_tombstones", [
      { user_id: USER, resource_type: "contact", resource_id: DELETED, sync_seq: 3 },
    ]);
    // Token cut exactly at C1's updated_at: strictly-greater means C1 must
    // NOT be resent (equal is "already seen"), while C2 and the group are.
    const res = await report(syncCollectionBody({ token: token(USER, new Date(T1).getTime(), 0) }));
    const body = await res.text();
    expect(body).not.toContain(`${C1}.vcf`);
    expect(body).toContain(contactHref(C2));
    expect(body).toContain(`group-${G1}.vcf`);
    // The tombstoned contact appears as a 404 status block so iOS deletes it.
    expect(body).toContain(`${DELETED}.vcf`);
    expect(body).toContain("HTTP/1.1 404 Not Found");
  });
});
