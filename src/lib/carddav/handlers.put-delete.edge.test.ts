// Edge-branch companion to handlers.put-delete.test.ts. Same harness; these
// pin the single-resource branches the main suite leaves open:
//
//   - GET/HEAD on group vCards (the whole group read path was untested);
//   - GET conditional wildcards and the owner-row-without-decrypt 404;
//   - PUT: If-None-Match:* create success, the ETag-advance contract on a
//     successful replace, and the group UPDATE path with its preconditions;
//   - DELETE: malformed paths and already-gone groups.
//
// Rationale: iOS trusts the ETag returned by PUT verbatim — if it did not
// advance, the next PROPFIND would look like a remote change and iOS would
// re-fetch (harmless) or, worse, skip pushing a queued edit (data loss).

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

import { handlePut, handleGet, handleDelete } from "./handlers.server";
import { contactETag, groupETag } from "./vcard";

const USER = "user-1";
const EMAIL = "ios@example.com";
const BASE_URL = "http://localhost/api/public/carddav";

const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C_NEW = "99999999-9999-4999-8999-999999999999";
const FOREIGN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const G1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const G_NEW = "12121212-1212-4121-8121-121212121212";

const T1 = "2026-07-01T10:00:00.000Z";
const TG = "2026-07-02T10:00:00.000Z";

function contactPath(id: string): string {
  return `${EMAIL}/contacts/${id}.vcf`;
}
function groupPath(id: string): string {
  return `${EMAIL}/contacts/group-${id}.vcf`;
}

function vcardBody(lines: string[], uid = C1): string {
  return ["BEGIN:VCARD", "VERSION:3.0", `UID:${uid}`, ...lines, "END:VCARD", ""].join("\r\n");
}

function groupVcardBody(opts: { uid: string; name?: string; members?: string[] }): string {
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

function put(path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  const req = new Request(`${BASE_URL}/${path}`, { method: "PUT", body, headers });
  return handlePut(req, USER, EMAIL, path);
}

function get(
  path: string,
  headers: Record<string, string> = {},
  method: "GET" | "HEAD" = "GET",
): Promise<Response> {
  const req = new Request(`${BASE_URL}/${path}`, { method, headers });
  return handleGet(req, USER, EMAIL, path, method);
}

function del(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const req = new Request(`${BASE_URL}/${path}`, { method: "DELETE", headers });
  return handleDelete(req, USER, path);
}

function writesTo(kind: "inserts" | "updates" | "deletes" | "upserts", table: string) {
  return fake.calls[kind].filter((w) => w.table === table);
}

function contactFixture(id: string, updatedAt: string): DecryptedContact {
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
  } as DecryptedContact;
}

const savedEncKey = process.env.EMAIL_ENC_KEY;

beforeEach(() => {
  fake.reset();
  decryptedRows.clear();
  vi.clearAllMocks();
  fake.seed("contacts", [
    { id: C1, user_id: USER, updated_at: T1, email: "old@example.com", source: "google" },
  ]);
  fake.seed("contact_groups", [
    { id: G1, user_id: USER, name: "Clients", updated_at: TG, carddav_uid: null },
  ]);
  fake.seed("contact_group_members", [{ group_id: G1, contact_id: C1, user_id: USER }]);
  fake.seed("company_name_aliases", []);
  fake.seed("carddav_settings", [
    {
      user_id: USER,
      resync_nonce: 0,
      group_name_style: "leaf",
      include_summary_in_notes: true,
      use_company_logo_fallback: false,
    },
  ]);
  fake.seed("contact_phones", []);
  fake.seed("contact_emails", []);
  decryptedRows.set(C1, contactFixture(C1, T1));
  process.env.EMAIL_ENC_KEY = "test-key";
});

afterEach(() => {
  if (savedEncKey === undefined) delete process.env.EMAIL_ENC_KEY;
  else process.env.EMAIL_ENC_KEY = savedEncKey;
});

describe("GET group vCard", () => {
  it("serves the Apple group vCard with members, ETag, and no-cache", async () => {
    const res = await get(groupPath(G1));
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(groupETag(G1, TG));
    expect(res.headers.get("Content-Type")).toContain("text/vcard");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    const body = await res.text();
    expect(body).toContain("X-ADDRESSBOOKSERVER-KIND:group");
    expect(body).toContain("FN:Clients");
    expect(body).toContain(`X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${C1}`);
    // No stored carddav_uid → UID falls back to the stable group-<id> form.
    expect(body).toContain(`UID:group-${G1}`);

    const head = await get(groupPath(G1), {}, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("returns 304 on a matching If-None-Match (exact and weak) and 404 for unknown groups", async () => {
    const etag = groupETag(G1, TG);
    const exact = await get(groupPath(G1), { "If-None-Match": etag });
    expect(exact.status).toBe(304);
    expect(exact.headers.get("ETag")).toBe(etag);

    const weak = await get(groupPath(G1), { "If-None-Match": `W/${etag}` });
    expect(weak.status).toBe(304);

    const missing = await get(groupPath(G_NEW));
    expect(missing.status).toBe(404);
  });
});

describe("GET conditional and integrity branches", () => {
  it("returns 304 for If-None-Match: * on an existing contact", async () => {
    const res = await get(contactPath(C1), { "If-None-Match": "*" });
    expect(res.status).toBe(304);
    expect(getContactDecryptedMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the contact row exists but the decrypt comes back empty", async () => {
    // Data-integrity branch: the owner row is present but the encrypted blob
    // is gone/unreadable. Must 404 (client keeps its copy) rather than 200
    // with an empty vCard, which would wipe the contact on the device.
    decryptedRows.delete(C1);
    const res = await get(contactPath(C1));
    expect(res.status).toBe(404);
  });

  it("returns 404 for a path that names no .vcf resource", async () => {
    expect((await get(`${EMAIL}/contacts/`)).status).toBe(404);
    expect((await get(`${EMAIL}/contacts/shortname.vcf`)).status).toBe(404);
  });
});

describe("PUT precondition and ETag contract", () => {
  it("If-None-Match: * succeeds with 201 when the contact does not exist yet", async () => {
    const res = await put(contactPath(C_NEW), vcardBody(["FN:Fresh Person"], C_NEW), {
      "If-None-Match": "*",
    });
    expect(res.status).toBe(201);
    expect(writesTo("inserts", "contacts")).toHaveLength(1);
  });

  it("a successful replace advances the ETag to the persisted updated_at", async () => {
    let persistedUpdatedAt: string | undefined;
    fake.onUpdate("contacts", (payload) => {
      const patch = payload as { updated_at?: string };
      persistedUpdatedAt = patch.updated_at;
      // Simulate the DB applying the write so the handler's re-select sees
      // the new revision (the fake does not mutate seeded rows on its own).
      fake.seed("contacts", [
        {
          id: C1,
          user_id: USER,
          updated_at: persistedUpdatedAt,
          email: "old@example.com",
          source: "google",
        },
      ]);
    });

    const oldEtag = contactETag(C1, T1);
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Renamed"]));
    expect(res.status).toBe(204);
    expect(persistedUpdatedAt).toBeTruthy();
    expect(persistedUpdatedAt).not.toBe(T1);
    // The returned ETag must be derived from what the DB now holds — iOS
    // stores it verbatim and compares it against the next PROPFIND listing.
    expect(res.headers.get("ETag")).toBe(contactETag(C1, persistedUpdatedAt as string));
    expect(res.headers.get("ETag")).not.toBe(oldEtag);
  });
});

describe("PUT group vCard: update path and preconditions", () => {
  it("updates an existing group's name and replaces membership with owned members only", async () => {
    const res = await put(
      groupPath(G1),
      groupVcardBody({ uid: `group-${G1}`, name: "Renamed", members: [C1, FOREIGN] }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(res.headers.get("ETag")).not.toBe(groupETag(G1, TG));
    expect(res.headers.get("Location")).toBe(
      `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/group-${G1}.vcf`,
    );

    const updates = writesTo("updates", "contact_groups");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toMatchObject({ name: "Renamed" });
    expect((updates[0]!.payload as { updated_at?: string }).updated_at).toBeTruthy();

    // Membership is wiped and rebuilt from the vCard's MEMBER lines, with
    // the unowned contact id filtered out — never linked across users.
    const dels = writesTo("deletes", "contact_group_members");
    expect(dels).toHaveLength(1);
    expect(dels[0]!.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "group_id", value: G1 },
        { op: "eq", col: "user_id", value: USER },
      ]),
    );
    const inserts = writesTo("inserts", "contact_group_members");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload).toEqual([{ group_id: G1, contact_id: C1, user_id: USER }]);
  });

  it("an empty MEMBER list clears membership without inserting anything", async () => {
    const res = await put(
      groupPath(G1),
      groupVcardBody({ uid: `group-${G1}`, name: "Clients", members: [] }),
    );
    expect(res.status).toBe(204);
    expect(writesTo("deletes", "contact_group_members")).toHaveLength(1);
    expect(writesTo("inserts", "contact_group_members")).toHaveLength(0);
  });

  it("enforces If-None-Match: * and If-Match 412s on groups, writing nothing", async () => {
    const body = groupVcardBody({ uid: `group-${G1}`, name: "Clients" });

    const inm = await put(groupPath(G1), body, { "If-None-Match": "*" });
    expect(inm.status).toBe(412);

    const stale = await put(groupPath(G1), body, { "If-Match": '"stale-etag"' });
    expect(stale.status).toBe(412);

    const ghost = await put(groupPath(G_NEW), groupVcardBody({ uid: `group-${G_NEW}` }), {
      "If-Match": '"whatever"',
    });
    expect(ghost.status).toBe(412);

    expect(writesTo("updates", "contact_groups")).toHaveLength(0);
    expect(writesTo("inserts", "contact_groups")).toHaveLength(0);
    expect(writesTo("deletes", "contact_group_members")).toHaveLength(0);
  });

  it("a KIND:group vCard PUT to a contact-style path is rejected with 400", async () => {
    // parsed.isGroup routes to the group path, which then finds no
    // group-<uuid> in the URL. Must fail loudly instead of half-creating a
    // group under a contact id.
    const res = await put(
      contactPath(C_NEW),
      groupVcardBody({ uid: `group-${G_NEW}`, name: "Oops" }),
    );
    expect(res.status).toBe(400);
    expect(writesTo("inserts", "contact_groups")).toHaveLength(0);
    expect(writesTo("inserts", "contacts")).toHaveLength(0);
  });

  it("a group vCard without FN is created as 'Untitled group'", async () => {
    const res = await put(groupPath(G_NEW), groupVcardBody({ uid: `group-${G_NEW}` }));
    expect(res.status).toBe(201);
    const inserts = writesTo("inserts", "contact_groups");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload).toMatchObject({ id: G_NEW, name: "Untitled group" });
  });
});

describe("DELETE edge branches", () => {
  it("rejects a non-UUID resource path with 400 before touching anything", async () => {
    const res = await del(`${EMAIL}/contacts/shortname.vcf`);
    expect(res.status).toBe(400);
    expect(fake.calls.deletes).toHaveLength(0);
    expect(writesTo("upserts", "carddav_tombstones")).toHaveLength(0);
  });

  it("returns 404 for an already-gone group and lays no tombstone", async () => {
    const res = await del(groupPath(G_NEW));
    expect(res.status).toBe(404);
    expect(writesTo("deletes", "contact_groups")).toHaveLength(0);
    // No tombstone for a resource we never had — a spurious tombstone would
    // bump the CTag and 404 an unrelated href on every client's next sync.
    expect(writesTo("upserts", "carddav_tombstones")).toHaveLength(0);
  });

  it("tombstones carry a deleted_at timestamp for the 90-day prune horizon", async () => {
    const before = Date.now();
    const res = await del(contactPath(C1));
    expect(res.status).toBe(204);
    const tombs = writesTo("upserts", "carddav_tombstones");
    expect(tombs).toHaveLength(1);
    const deletedAt = (tombs[0]!.payload as { deleted_at?: string }).deleted_at;
    expect(deletedAt).toBeTruthy();
    const t = new Date(deletedAt as string).getTime();
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
