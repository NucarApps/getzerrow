// Shared harness for the CardDAV handler suites (handlers.put-delete.test.ts
// and handlers.propfind-report.test.ts). It owns the Supabase fake, the mocks
// for every boundary `handlers.server.ts` reaches through, the seed data, and
// the request helpers, so the suites carry tests instead of ~75 lines of
// identical preamble each.
//
// HOW TO USE IT. `vi.mock` calls must stay in the test file (vitest hoists
// them above the imports, per module graph), but the factories delegate here:
//
//   vi.mock("@/lib/log.server", async () => (await import("./__fixtures__/handler-harness")).mockLogServer());
//
// then call `setupCardDavHarness()` once at the top level to register the
// before/after hooks. The full list of modules that must be mocked is
// `CARDDAV_MOCKED_MODULES` below; leaving one out means the real module
// loads and the suite talks to production code.
//
// FROZEN CLOCK. Every test runs at `FIXED_ISO` under `vi.useFakeTimers`, so
// `new Date().toISOString()` inside the handlers is exactly that value. ETag,
// `deleted_at` and sync-token assertions are therefore exact equalities
// (`contactETag(id, FIXED_ISO)`), not `toBeTruthy()` and ±1 s windows.
//
// CAVEAT — the fake's ordering is NOT production's. `makeSupabaseFake`
// compares `updated_at` as JS strings, while Postgres compares `timestamptz`
// at microsecond resolution against a token whose millisecond value came from
// `buildSyncToken` (`new Date(iso).getTime()`, which TRUNCATES sub-millisecond
// precision). A row written at `…:00.0004Z` is therefore strictly greater
// than a token minted from it in production and would be resent forever,
// while the fake — comparing ISO strings both truncated to milliseconds —
// calls them equal. Do not "fix" the `.gt("updated_at", …)` filter in
// handlers.server.ts on the strength of what this fake reports.

import { beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import type { DecryptedContact } from "@/lib/sync/encrypted-reader";

/** Every module a CardDAV handler suite has to mock. Kept here so a new
 * suite can be checked against one list instead of a neighbouring file. */
export const CARDDAV_MOCKED_MODULES = [
  "@/integrations/supabase/client.server",
  "@/lib/sync/encrypted-reader",
  "@/lib/sync/encrypted-writer",
  "@/lib/contacts/revisions.server",
  "@/lib/log.server",
  "@/lib/contacts/photos.server",
  "@/lib/contacts/logo-photo.server",
  "@/lib/contacts/label-resolve.server",
  "@/lib/companies/resolve.server",
  "@/lib/contacts/auto-company-subgroups.functions",
  "@/lib/contacts/group-rules.functions",
  "@/lib/google-contacts/mark-dirty.server",
] as const;

// ---------------------------------------------------------------------------
// Frozen clock and fixture identities

/** 2026-07-15T12:00:00.000Z — recent enough that the 90-day sync-token
 * horizon accepts the fixture timestamps, and fixed so nothing depends on
 * when the suite ran. */
export const FIXED_MS = Date.UTC(2026, 6, 15, 12, 0, 0);
export const FIXED_ISO = new Date(FIXED_MS).toISOString();
export const DAY = 24 * 60 * 60 * 1000;

export const USER = "user-1";
export const EMAIL = "ios@example.com";
export const BASE_URL = "http://localhost/api/public/carddav";

// UUID-shaped ids: the href routing regexes require [0-9a-f-]{36}.
export const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const C2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const C_NEW = "99999999-9999-4999-8999-999999999999";
export const SPOOFED_UID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
export const FOREIGN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const NEVER_EXISTED = "12345678-1234-4123-8123-123456789abc";
export const DELETED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const G1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const G2 = "11111111-2222-4333-8444-555555555555";
export const G_NEW = "12121212-1212-4121-8121-121212121212";
export const G_CHILD = "77777777-7777-4777-8777-777777777777";

/** Contact 1's revision, 3 days before "now". */
export const T1 = new Date(FIXED_MS - 3 * DAY).toISOString();
/** Contact 2's revision, 2 days before "now". */
export const T2 = new Date(FIXED_MS - 2 * DAY).toISOString();
/** The group's revision, 1 day before "now" — the newest thing in the book,
 * so it is what a freshly minted sync token encodes. */
export const TG = new Date(FIXED_MS - 1 * DAY).toISOString();

export const GOOGLE_DIRTY_SENTINEL = "1970-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Fake + mocks

/** `applyWrites` so a PUT's own re-select sees what it just wrote — that is
 * what makes the response ETag assertion an exact equality. */
export const fake = makeSupabaseFake({ applyWrites: true });
const supabaseAdminMock = mockSupabaseAdmin(() => fake);

/** Decrypted rows keyed by contact id, backing the `getContactDecrypted`
 * mock. Delete an entry to simulate an unreadable encrypted blob. */
export const decryptedRows = new Map<string, DecryptedContact>();

/** Ordered log of side effects, so a test can assert snapshot-before-write. */
export const ops: string[] = [];

export type PhotoBytes = { bytes: Uint8Array; mime: string };

export const mocks = {
  getContactDecrypted: vi.fn<(contactId: string) => Promise<{ row: DecryptedContact | null }>>(),
  setContactEncryptedFields: vi.fn<(input: unknown) => Promise<{ error: string | null }>>(),
  snapshotContact: vi.fn<(...args: unknown[]) => Promise<void>>(),
  logInfo: vi.fn<(...args: unknown[]) => void>(),
  logError: vi.fn<(...args: unknown[]) => void>(),
  saveContactPhoto:
    vi.fn<
      (
        userId: string,
        contactId: string,
        bytes: Uint8Array,
        mime: string,
        source: string,
      ) => Promise<{ avatarUrl: string; hash: string }>
    >(),
  loadContactPhotoBytes: vi.fn<(url: string | null) => Promise<PhotoBytes | null>>(),
  fetchChosenCompanyLogoBytes:
    vi.fn<(userId: string, domain: string | null) => Promise<PhotoBytes | null>>(),
  fetchCompanyPhotoOrLogoBytes:
    vi.fn<
      (
        userId: string,
        args: { companyId: string | null; domain: string | null },
      ) => Promise<PhotoBytes | null>
    >(),
  resolveCompanyLogoDomainForContact:
    vi.fn<(userId: string, row: unknown) => Promise<string | null>>(),
  recordCompanyLogoHash: vi.fn<(args: unknown) => Promise<void>>(),
  resolveOrCreateCompanyLabel: vi.fn<
    (
      ctx: unknown,
      args: { rawName: string; parentGroupId?: string | null },
    ) => Promise<{
      id: string;
      name: string;
    } | null>
  >(),
  resolveContactCompany:
    vi.fn<(ctx: unknown, companyText: string | null) => Promise<{ companyId: string | null }>>(),
  reconcileAutoParentsForContacts: vi.fn<(...args: unknown[]) => Promise<void>>(),
  applyRulesForContact: vi.fn<(...args: unknown[]) => Promise<void>>(),
  markGooglePhotoDirty: vi.fn<(userId: string, contactId: string) => Promise<void>>(),
};

/** Re-arm the inert defaults. Called from the harness `beforeEach` after a
 * full reset, so a `mockResolvedValueOnce` in one test cannot leak forward. */
function installMockDefaults(): void {
  mocks.getContactDecrypted.mockImplementation(async (contactId: string) => ({
    row: decryptedRows.get(contactId) ?? null,
  }));
  mocks.setContactEncryptedFields.mockImplementation(async () => ({ error: null }));
  mocks.snapshotContact.mockImplementation(async () => {
    ops.push("snapshot");
  });
  mocks.logInfo.mockImplementation(() => {});
  mocks.logError.mockImplementation(() => {});
  mocks.saveContactPhoto.mockImplementation(async () => {
    ops.push("save_photo");
    return { avatarUrl: "https://storage.test/contact-photos/new.jpg", hash: "abcdef0123456789" };
  });
  mocks.loadContactPhotoBytes.mockImplementation(async () => null);
  mocks.fetchChosenCompanyLogoBytes.mockImplementation(async () => null);
  mocks.fetchCompanyPhotoOrLogoBytes.mockImplementation(async () => null);
  mocks.resolveCompanyLogoDomainForContact.mockImplementation(async () => null);
  mocks.recordCompanyLogoHash.mockImplementation(async () => {});
  mocks.resolveOrCreateCompanyLabel.mockImplementation(async () => null);
  mocks.resolveContactCompany.mockImplementation(async () => ({ companyId: null }));
  mocks.reconcileAutoParentsForContacts.mockImplementation(async () => {});
  mocks.applyRulesForContact.mockImplementation(async () => {});
  mocks.markGooglePhotoDirty.mockImplementation(async () => {});
}

// ---------------------------------------------------------------------------
// vi.mock factory bodies. Each one is what the matching `vi.mock` in a suite
// returns; property access is deferred into method bodies so nothing is read
// at hoist time.

export function mockSupabaseClient() {
  return { supabaseAdmin: supabaseAdminMock };
}
export function mockEncryptedReader() {
  return { getContactDecrypted: (contactId: string) => mocks.getContactDecrypted(contactId) };
}
export function mockEncryptedWriter() {
  return { setContactEncryptedFields: (input: unknown) => mocks.setContactEncryptedFields(input) };
}
export function mockRevisions() {
  return { snapshotContact: (...args: unknown[]) => mocks.snapshotContact(...args) };
}
export function mockLogServer() {
  return {
    logInfo: (...args: unknown[]) => mocks.logInfo(...args),
    logError: (...args: unknown[]) => mocks.logError(...args),
  };
}
/** `sha256Hex` stays REAL: the PUT photo branch is a hash-comparison ladder,
 * and a stubbed digest would make every echo/no-op decision vacuous. */
export async function mockPhotosServer() {
  const actual = await vi.importActual<typeof import("@/lib/contacts/photos.server")>(
    "@/lib/contacts/photos.server",
  );
  return {
    sha256Hex: actual.sha256Hex,
    CONTACT_PHOTO_BUCKET: actual.CONTACT_PHOTO_BUCKET,
    saveContactPhoto: (
      userId: string,
      contactId: string,
      bytes: Uint8Array,
      mime: string,
      source: string,
    ) => mocks.saveContactPhoto(userId, contactId, bytes, mime, source),
    loadContactPhotoBytes: (url: string | null) => mocks.loadContactPhotoBytes(url),
  };
}
export function mockLogoPhoto() {
  return {
    fetchChosenCompanyLogoBytes: (userId: string, domain: string | null) =>
      mocks.fetchChosenCompanyLogoBytes(userId, domain),
    fetchCompanyPhotoOrLogoBytes: (
      userId: string,
      args: { companyId: string | null; domain: string | null },
    ) => mocks.fetchCompanyPhotoOrLogoBytes(userId, args),
    resolveCompanyLogoDomainForContact: (userId: string, row: unknown) =>
      mocks.resolveCompanyLogoDomainForContact(userId, row),
    recordCompanyLogoHash: (args: unknown) => mocks.recordCompanyLogoHash(args),
  };
}
export function mockLabelResolve() {
  return {
    resolveOrCreateCompanyLabel: (
      ctx: unknown,
      args: { rawName: string; parentGroupId?: string | null },
    ) => mocks.resolveOrCreateCompanyLabel(ctx, args),
  };
}
export function mockCompanyResolve() {
  return {
    resolveContactCompany: (ctx: unknown, companyText: string | null) =>
      mocks.resolveContactCompany(ctx, companyText),
  };
}
export function mockAutoCompanySubgroups() {
  return {
    reconcileAutoParentsForContacts: (...args: unknown[]) =>
      mocks.reconcileAutoParentsForContacts(...args),
  };
}
export function mockGroupRules() {
  return { applyRulesForContact: (...args: unknown[]) => mocks.applyRulesForContact(...args) };
}
export function mockMarkDirty() {
  return {
    markGooglePhotoDirty: (userId: string, contactId: string) =>
      mocks.markGooglePhotoDirty(userId, contactId),
  };
}

// ---------------------------------------------------------------------------
// Seeds

export function contactFixture(
  id: string,
  updatedAt: string,
  overrides: Partial<DecryptedContact> = {},
): DecryptedContact {
  return {
    id,
    user_id: USER,
    email: "old@example.com",
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
    ...overrides,
  } as DecryptedContact;
}

/** Two owned contacts, one owned group with C1 in it, default settings, and
 * empty side tables. `use_company_logo_fallback: false` keeps the read paths
 * off the logo fetch; `group_name_style: "leaf"` keeps the tree lookup out.
 * Individual tests re-seed the table they care about. */
export function seedBase(): void {
  fake.seed("contacts", [
    { id: C1, user_id: USER, updated_at: T1, email: "old@example.com", source: "google" },
    { id: C2, user_id: USER, updated_at: T2, email: "second@example.com", source: "google" },
  ]);
  fake.seed("contact_groups", [
    {
      id: G1,
      user_id: USER,
      name: "Clients",
      updated_at: TG,
      carddav_uid: null,
      parent_group_id: null,
      auto_generated_from_group_id: null,
      auto_company_subgroups: false,
    },
  ]);
  fake.seed("contact_group_members", [
    { group_id: G1, contact_id: C1, user_id: USER, auto_added: false },
  ]);
  fake.seed("carddav_settings", [
    {
      user_id: USER,
      resync_nonce: 0,
      group_name_style: "leaf",
      include_summary_in_notes: true,
      use_company_logo_fallback: false,
      photo_priority: "company_first",
    },
  ]);
  fake.seed("carddav_tombstones", []);
  fake.seed("contact_phones", []);
  fake.seed("contact_emails", []);
  fake.seed("company_name_aliases", []);
  fake.seed("companies", []);
  fake.seed("google_contact_links", []);
  fake.seed("folder_filters", []);
  decryptedRows.set(C1, contactFixture(C1, T1));
  decryptedRows.set(C2, contactFixture(C2, T2, { email: "second@example.com" }));
}

/** Overwrite `carddav_settings` with one patch applied over the defaults. */
export function seedSettings(patch: {
  resync_nonce?: number;
  group_name_style?: string;
  include_summary_in_notes?: boolean;
  use_company_logo_fallback?: boolean;
  photo_priority?: "company_first" | "personal_first" | "personal_only";
}): void {
  fake.seed("carddav_settings", [
    {
      user_id: USER,
      resync_nonce: 0,
      group_name_style: "leaf",
      include_summary_in_notes: true,
      use_company_logo_fallback: false,
      photo_priority: "company_first",
      ...patch,
    },
  ]);
}

// ---------------------------------------------------------------------------
// Request helpers. These import the handlers lazily so the harness can be
// imported from a `vi.mock` factory without pulling handlers.server.ts into
// the module graph before the mocks are registered.

async function handlers() {
  return import("../handlers.server");
}

export function contactPath(id: string): string {
  return `${EMAIL}/contacts/${id}.vcf`;
}
export function groupPath(id: string): string {
  return `${EMAIL}/contacts/group-${id}.vcf`;
}
export function contactHref(id: string): string {
  return `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/${id}.vcf`;
}
export function groupHref(id: string): string {
  return `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/group-${id}.vcf`;
}
/** The addressbook collection itself — the href a sync-collection REPORT
 * hangs its truncation marker off. */
export function bookHref(): string {
  return `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/`;
}

export function vcardBody(lines: string[], uid = C1): string {
  return ["BEGIN:VCARD", "VERSION:3.0", `UID:${uid}`, ...lines, "END:VCARD", ""].join("\r\n");
}

export function groupVcardBody(opts: { uid: string; name?: string; members?: string[] }): string {
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${opts.uid}`,
    ...(opts.name !== undefined ? [`FN:${opts.name}`, `N:${opts.name};;;;`] : []),
    "X-ADDRESSBOOKSERVER-KIND:group",
    ...(opts.members ?? []).map((id) => `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${id}`),
    "END:VCARD",
    "",
  ].join("\r\n");
}

export function multigetBody(hrefs: string[], props = "<D:getetag/><C:address-data/>"): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">' +
    `<D:prop>${props}</D:prop>` +
    hrefs.map((h) => `<D:href>${h}</D:href>`).join("") +
    "</C:addressbook-multiget>"
  );
}

export function syncCollectionBody(
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

/** The exact token format `buildSyncToken` mints. */
export function syncToken(userId: string, ms: number, seq: number): string {
  return `urn:atzro:carddav:${userId}:${ms}:${seq}`;
}

export async function put(
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const { handlePut } = await handlers();
  const req = new Request(`${BASE_URL}/${path}`, { method: "PUT", body, headers });
  return handlePut(req, USER, EMAIL, path);
}

export async function get(
  path: string,
  headers: Record<string, string> = {},
  method: "GET" | "HEAD" = "GET",
): Promise<Response> {
  const { handleGet } = await handlers();
  const req = new Request(`${BASE_URL}/${path}`, { method, headers });
  return handleGet(req, USER, EMAIL, path, method);
}

export async function del(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const { handleDelete } = await handlers();
  const req = new Request(`${BASE_URL}/${path}`, { method: "DELETE", headers });
  return handleDelete(req, USER, path);
}

export async function propfind(
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Response> {
  const { handlePropfind } = await handlers();
  const req = new Request(`${BASE_URL}/${path}`, { method: "PROPFIND", headers, body });
  return handlePropfind(req, USER, EMAIL, path);
}

export async function report(body: string): Promise<Response> {
  const { handleReport } = await handlers();
  const req = new Request(`${BASE_URL}/${EMAIL}/contacts/`, { method: "REPORT", body });
  return handleReport(req, USER, EMAIL);
}

/** The book CTag from a depth-0 PROPFIND on the addressbook. */
export async function readCTag(): Promise<string> {
  const res = await propfind(`${EMAIL}/contacts`, { depth: "0" });
  const body = await res.text();
  const m = body.match(/<CS:getctag>([\s\S]*?)<\/CS:getctag>/);
  if (!m?.[1]) throw new Error(`no CTag in: ${body}`);
  return m[1];
}

/** The `<D:sync-token>` a sync-collection REPORT minted, unescaped enough for
 * a round-trip through `syncCollectionBody`. */
export function tokenFrom(responseBody: string): string {
  const m = responseBody.match(/<D:sync-token>([\s\S]*?)<\/D:sync-token>/);
  if (!m?.[1]) throw new Error(`no sync-token in: ${responseBody}`);
  return m[1].replace(/&amp;/g, "&");
}

export function writesTo(
  kind: "inserts" | "updates" | "deletes" | "upserts",
  table: string,
): Array<{ table: string; payload: unknown; options?: unknown; filters: unknown[] }> {
  return fake.calls[kind].filter((w) => w.table === table);
}

// ---------------------------------------------------------------------------
// Hook registration

/** Register the per-test reset: fresh fake, frozen clock, inert mocks, base
 * seed. Call once at the top level of a suite; a suite's own `beforeEach`
 * runs after this one, so it can re-seed whatever it needs. */
export function setupCardDavHarness(): void {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_MS });
    fake.reset();
    decryptedRows.clear();
    ops.length = 0;
    for (const mock of Object.values(mocks)) mock.mockReset();
    installMockDefaults();
    // The encryption boundary is mocked; the key is stubbed anyway so a gap
    // in a mock fails loudly in the RPC layer rather than on a missing env
    // var. The global teardown unstubs it.
    vi.stubEnv("EMAIL_ENC_KEY", "test-key");
    seedBase();
  });
}
