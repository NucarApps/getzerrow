// Handler-level tests for the CardDAV write paths: PUT (contact + group),
// GET/HEAD conditional fetches, and DELETE. The vcard parser and the merge
// logic stay REAL — these tests protect the glue the pure-layer tests can't:
//
//   - the field-preservation contract: iOS routinely PUTs partial vCards for
//     single-field edits; anything the vCard omitted (TEL, EMAIL, NOTE, ADR,
//     CATEGORIES) must survive untouched in every table it lives in;
//   - ownership: the verified auth userId decides everything — a spoofed
//     vCard UID or an unowned group member must never cross user boundaries;
//   - If-Match / If-None-Match 412 semantics that keep two devices from
//     silently clobbering each other;
//   - the snapshot-before-write safety net and the dirty-sentinel bridge
//     that forces the next Google Contacts run to push a CardDAV edit.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import type { DecryptedContact } from "@/lib/sync/encrypted-reader";

const fake = makeSupabaseFake();
const decryptedRows = new Map<string, DecryptedContact>();
// Ordered log of side effects so tests can assert snapshot-before-update.
const ops: string[] = [];
const getContactDecryptedMock = vi.fn(async (contactId: string) => ({
  row: decryptedRows.get(contactId) ?? null,
  error: null,
}));
const setContactEncryptedFieldsMock = vi.fn(async (_input: unknown) => ({
  error: null as string | null,
}));
const snapshotContactMock = vi.fn(async (..._args: unknown[]) => {
  ops.push("snapshot");
});
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
const SPOOFED_UID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const FOREIGN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const G1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const G2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const G_NEW = "12121212-1212-4121-8121-121212121212";

const T1 = "2026-07-01T10:00:00.000Z";
const TG = "2026-07-02T10:00:00.000Z";

const GOOGLE_DIRTY_SENTINEL = "1970-01-01T00:00:00.000Z";

function contactPath(id: string): string {
  return `${EMAIL}/contacts/${id}.vcf`;
}

function vcardBody(lines: string[], uid = C1): string {
  return ["BEGIN:VCARD", "VERSION:3.0", `UID:${uid}`, ...lines, "END:VCARD", ""].join("\r\n");
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
  ops.length = 0;
  vi.clearAllMocks();
  fake.seed("contacts", [
    { id: C1, user_id: USER, updated_at: T1, email: "old@example.com", source: "google" },
  ]);
  fake.seed("contact_groups", []);
  fake.seed("contact_group_members", []);
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
  fake.onUpdate("contacts", () => {
    ops.push("contacts_update");
  });
  process.env.EMAIL_ENC_KEY = "test-key";
});

afterEach(() => {
  if (savedEncKey === undefined) delete process.env.EMAIL_ENC_KEY;
  else process.env.EMAIL_ENC_KEY = savedEncKey;
});

describe("PUT input validation", () => {
  it("returns 400 for a body that is not a vCard, before any write", async () => {
    const res = await put(contactPath(C1), "definitely not a vcard");
    expect(res.status).toBe(400);
    expect(fake.calls.updates.length + fake.calls.inserts.length).toBe(0);
  });

  it("returns 400 for a non-UUID resource path", async () => {
    const res = await put(`${EMAIL}/contacts/shortname.vcf`, vcardBody(["FN:Erica Roy"]));
    expect(res.status).toBe(400);
    expect(fake.calls.updates.length + fake.calls.inserts.length).toBe(0);
  });
});

describe("PUT create", () => {
  it("creates with the path UUID + auth user_id, ignoring a spoofed vCard UID", async () => {
    const res = await put(contactPath(C_NEW), vcardBody(["FN:New Person"], SPOOFED_UID));
    expect(res.status).toBe(201);
    expect(res.headers.get("Location")).toBe(
      `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/${C_NEW}.vcf`,
    );
    expect(res.headers.get("ETag")).toBeTruthy();

    const inserts = writesTo("inserts", "contacts");
    expect(inserts).toHaveLength(1);
    const payload = inserts[0].payload as Record<string, unknown>;
    // Ownership contract: identity comes from the URL + verified auth user,
    // never from what the client typed into the vCard body.
    expect(payload.id).toBe(C_NEW);
    expect(payload.user_id).toBe(USER);
    expect(payload.name).toBe("New Person");
    expect(String(payload.id)).not.toBe(SPOOFED_UID);
    // Brand new record: nothing to snapshot yet.
    expect(snapshotContactMock).not.toHaveBeenCalled();
  });
});

describe("PUT preconditions", () => {
  it("If-None-Match: * fails with 412 when the contact already exists", async () => {
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy"]), {
      "If-None-Match": "*",
    });
    expect(res.status).toBe(412);
    expect(writesTo("updates", "contacts")).toHaveLength(0);
  });

  it("stale If-Match fails with 412 and writes nothing", async () => {
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy"]), {
      "If-Match": '"deadbeef-stale"',
    });
    expect(res.status).toBe(412);
    expect(writesTo("updates", "contacts")).toHaveLength(0);
    expect(snapshotContactMock).not.toHaveBeenCalled();
  });

  it("current If-Match passes and the replace returns 204", async () => {
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy"]), {
      "If-Match": contactETag(C1, T1),
    });
    expect(res.status).toBe(204);
    expect(writesTo("updates", "contacts")).toHaveLength(1);
  });

  it("weak-form If-Match (W/ prefix) is accepted against the strong ETag", async () => {
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy"]), {
      "If-Match": `W/${contactETag(C1, T1)}`,
    });
    expect(res.status).toBe(204);
  });

  it("If-Match against a nonexistent contact fails with 412 (not create)", async () => {
    const res = await put(contactPath(C_NEW), vcardBody(["FN:Ghost"]), {
      "If-Match": '"whatever"',
    });
    expect(res.status).toBe(412);
    expect(writesTo("inserts", "contacts")).toHaveLength(0);
  });
});

describe("PUT field preservation", () => {
  it("a partial vCard without TEL leaves phones and encrypted fields untouched", async () => {
    // The field-preservation contract: iOS sends FN-only cards for name
    // edits; the stored phone rows and the encrypted phone/notes/address
    // must survive exactly as they were.
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Renamed"]));
    expect(res.status).toBe(204);
    expect(writesTo("deletes", "contact_phones")).toHaveLength(0);
    expect(writesTo("inserts", "contact_phones")).toHaveLength(0);
    expect(setContactEncryptedFieldsMock).not.toHaveBeenCalled();
    // No CATEGORIES line → group membership untouched too.
    expect(writesTo("upserts", "contact_group_members")).toHaveLength(0);
    expect(writesTo("deletes", "contact_group_members")).toHaveLength(0);
  });

  it("a vCard with TEL replaces all phones and patches the encrypted primary", async () => {
    const res = await put(
      contactPath(C1),
      vcardBody([
        "FN:Erica Roy",
        "TEL;TYPE=CELL:+1 (555) 111-2222",
        "TEL;TYPE=WORK:+1 555 333 4444",
      ]),
    );
    expect(res.status).toBe(204);

    const dels = writesTo("deletes", "contact_phones");
    expect(dels).toHaveLength(1);
    expect(dels[0].filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "contact_id", value: C1 },
        { op: "eq", col: "user_id", value: USER },
      ]),
    );

    const inserts = writesTo("inserts", "contact_phones");
    expect(inserts).toHaveLength(1);
    const rows = inserts[0].payload as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      user_id: USER,
      contact_id: C1,
      label: "mobile",
      number: "+1 (555) 111-2222",
      is_primary: true, // no PREF marker → first row becomes primary
      position: 0,
    });
    expect(rows[1]).toMatchObject({ label: "work", is_primary: false, position: 1 });

    // The encrypted legacy phone column mirrors the primary number.
    expect(setContactEncryptedFieldsMock).toHaveBeenCalledWith({
      contact_id: C1,
      phone: "+1 (555) 111-2222",
    });
  });

  it("a blank EMAIL slot never wipes stored emails or the email column", async () => {
    // Handler-level companion to sync.regression.test.ts: the parser drops
    // blank EMAIL slots, so the handler must neither touch contact_emails
    // nor include an `email` key in the contacts update.
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy", "EMAIL;TYPE=INTERNET:"]));
    expect(res.status).toBe(204);
    expect(writesTo("deletes", "contact_emails")).toHaveLength(0);
    expect(writesTo("inserts", "contact_emails")).toHaveLength(0);
    const patch = writesTo("updates", "contacts")[0].payload as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(patch, "email")).toBe(false);
  });

  it("NOTE is stripped of the AI summary block and ADR maps into encrypted lines", async () => {
    // The 🤖-summary block is server-owned: an iOS PUT echoes it back inside
    // NOTE and only the user's own text below the marker may be persisted.
    const res = await put(
      contactPath(C1),
      vcardBody([
        "FN:Erica Roy",
        "NOTE:🤖 Zerrow summary\\nAI facts here\\n\\n— My notes —\\nkeep me",
        "ADR;TYPE=WORK:;;123 Main St;Springfield;IL;62704;USA",
      ]),
    );
    expect(res.status).toBe(204);
    expect(setContactEncryptedFieldsMock).toHaveBeenCalledWith({
      contact_id: C1,
      notes: "keep me",
      address_line1: "123 Main St",
      address_line2: "", // absent second line clears, per the ADR-present contract
    });
    // Plaintext city/region ride the contacts patch.
    const patch = writesTo("updates", "contacts")[0].payload as Record<string, unknown>;
    expect(patch).toMatchObject({ city: "Springfield", region: "IL", postal_code: "62704" });
  });

  it("CATEGORIES reconciles manual memberships: joins matched groups, leaves dropped ones", async () => {
    fake.seed("contact_groups", [
      {
        id: G1,
        user_id: USER,
        name: "Clients",
        parent_group_id: null,
        auto_generated_from_group_id: null,
        auto_company_subgroups: false,
        updated_at: TG,
        carddav_uid: null,
      },
      {
        id: G2,
        user_id: USER,
        name: "Old Circle",
        parent_group_id: null,
        auto_generated_from_group_id: null,
        auto_company_subgroups: false,
        updated_at: TG,
        carddav_uid: null,
      },
    ]);
    fake.seed("contact_group_members", [
      { group_id: G2, contact_id: C1, user_id: USER, auto_added: false },
    ]);

    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy", "CATEGORIES:Clients"]));
    expect(res.status).toBe(204);

    const upserts = writesTo("upserts", "contact_group_members");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload).toEqual([
      { group_id: G1, contact_id: C1, user_id: USER, auto_added: false },
    ]);
    expect(upserts[0].options).toEqual({
      onConflict: "group_id,contact_id",
      ignoreDuplicates: true,
    });

    // Only MANUAL rows are diffed away, scoped by auto_added=false.
    const dels = writesTo("deletes", "contact_group_members");
    expect(dels).toHaveLength(1);
    expect(dels[0].filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "auto_added", value: false },
        { op: "in", col: "group_id", value: [G2] },
      ]),
    );
  });
});

describe("PUT bookkeeping", () => {
  it("snapshots the previous state BEFORE the contacts update (restore safety net)", async () => {
    await put(contactPath(C1), vcardBody(["FN:Erica Roy"]));
    expect(snapshotContactMock).toHaveBeenCalledWith(USER, C1, "carddav_put");
    expect(ops.indexOf("snapshot")).toBeLessThan(ops.indexOf("contacts_update"));
  });

  it("flags the Google link dirty so the next two-way run pushes the CardDAV edit", async () => {
    await put(contactPath(C1), vcardBody(["FN:Erica Roy"]));
    const linkUpdates = writesTo("updates", "google_contact_links");
    expect(linkUpdates).toHaveLength(1);
    expect(linkUpdates[0].payload).toEqual({ last_synced_at: GOOGLE_DIRTY_SENTINEL });
    expect(linkUpdates[0].filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "user_id", value: USER },
        { op: "eq", col: "contact_id", value: C1 },
      ]),
    );
  });
});

describe("PUT group vCard", () => {
  it("creates the group and filters member UIDs down to contacts the user owns", async () => {
    const body = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `UID:group-${G_NEW}`,
      "FN:VIPs",
      "N:VIPs;;;;",
      "X-ADDRESSBOOKSERVER-KIND:group",
      `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${C1}`,
      `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${FOREIGN}`,
      "END:VCARD",
      "",
    ].join("\r\n");
    const res = await put(`${EMAIL}/contacts/group-${G_NEW}.vcf`, body);
    expect(res.status).toBe(201);
    expect(res.headers.get("ETag")).toBeTruthy();

    const groupInserts = writesTo("inserts", "contact_groups");
    expect(groupInserts).toHaveLength(1);
    expect(groupInserts[0].payload).toMatchObject({
      id: G_NEW,
      user_id: USER,
      name: "VIPs",
      carddav_uid: `group-${G_NEW}`,
    });

    // Membership is set to exactly the OWNED member UIDs — the foreign
    // contact id must be dropped, never linked across users.
    const memberInserts = writesTo("inserts", "contact_group_members");
    expect(memberInserts).toHaveLength(1);
    expect(memberInserts[0].payload).toEqual([{ group_id: G_NEW, contact_id: C1, user_id: USER }]);
  });
});

describe("GET / HEAD", () => {
  it("returns 404 for a contact the user does not own", async () => {
    const res = await get(contactPath(C_NEW));
    expect(res.status).toBe(404);
  });

  it("returns 304 with the ETag when If-None-Match matches (quoted and W/ forms)", async () => {
    const etag = contactETag(C1, T1);
    const exact = await get(contactPath(C1), { "If-None-Match": etag });
    expect(exact.status).toBe(304);
    expect(exact.headers.get("ETag")).toBe(etag);
    // Not even the decrypt boundary is touched on a cache hit.
    expect(getContactDecryptedMock).not.toHaveBeenCalled();

    const weak = await get(contactPath(C1), { "If-None-Match": `W/${etag}` });
    expect(weak.status).toBe(304);
  });

  it("returns the vCard with ETag + no-cache on GET, and an empty body on HEAD", async () => {
    const res = await get(contactPath(C1));
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(contactETag(C1, T1));
    expect(res.headers.get("Content-Type")).toContain("text/vcard");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    const body = await res.text();
    expect(body).toContain("BEGIN:VCARD");
    expect(body).toContain(`UID:${C1}`);

    const head = await get(contactPath(C1), {}, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

describe("DELETE", () => {
  it("hard-deletes a contact: phones first, then the row, then a tombstone", async () => {
    const res = await del(contactPath(C1));
    expect(res.status).toBe(204);
    expect(writesTo("deletes", "contact_phones")).toHaveLength(1);
    expect(writesTo("deletes", "contacts")).toHaveLength(1);
    const tombs = writesTo("upserts", "carddav_tombstones");
    expect(tombs).toHaveLength(1);
    expect(tombs[0].payload).toMatchObject({
      user_id: USER,
      resource_type: "contact",
      resource_id: C1,
    });
    expect(tombs[0].options).toEqual({ onConflict: "user_id,resource_type,resource_id" });
  });

  it("returns 404 for an unknown contact and 412 for a stale If-Match", async () => {
    expect((await del(contactPath(C_NEW))).status).toBe(404);

    const stale = await del(contactPath(C1), { "If-Match": '"stale-etag"' });
    expect(stale.status).toBe(412);
    expect(writesTo("deletes", "contacts")).toHaveLength(0);

    // The real current ETag still deletes.
    const ok = await del(contactPath(C1), { "If-Match": contactETag(C1, T1) });
    expect(ok.status).toBe(204);
  });

  it("deletes a group with its memberships, sender_in_group filters, and a group tombstone", async () => {
    fake.seed("contact_groups", [
      { id: G1, user_id: USER, name: "Clients", updated_at: TG, carddav_uid: null },
    ]);
    // Group deletes honor If-Match against the group ETag too.
    const res = await del(`${EMAIL}/contacts/group-${G1}.vcf`, {
      "If-Match": groupETag(G1, TG),
    });
    expect(res.status).toBe(204);

    const memberDels = writesTo("deletes", "contact_group_members");
    expect(memberDels).toHaveLength(1);
    expect(memberDels[0].filters).toEqual(
      expect.arrayContaining([{ op: "eq", col: "group_id", value: G1 }]),
    );

    // Folder rules that referenced the group must not dangle.
    const filterDels = writesTo("deletes", "folder_filters");
    expect(filterDels).toHaveLength(1);
    expect(filterDels[0].filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "op", value: "sender_in_group" },
        { op: "eq", col: "value", value: G1 },
      ]),
    );

    expect(writesTo("deletes", "contact_groups")).toHaveLength(1);
    const tombs = writesTo("upserts", "carddav_tombstones");
    expect(tombs[0].payload).toMatchObject({ resource_type: "group", resource_id: G1 });
  });
});
