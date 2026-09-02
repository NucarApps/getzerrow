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
//     that forces the next Google Contacts run to push a CardDAV edit;
//   - the PHOTO echo ladder, which is where "the photo I set on my iPhone
//     reverts a minute later" came from;
//   - every DB-failure branch answering 5xx rather than a 2xx the client
//     would take as "saved".
//
// Fixture, clock and boundary mocks all live in
// __fixtures__/handler-harness.ts; read its header before adding tests.

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

import { contactETag, groupETag } from "./vcard";
import { sha256Hex } from "@/lib/contacts/photos.server";

const {
  fake,
  mocks,
  decryptedRows,
  ops,
  FIXED_ISO,
  USER,
  EMAIL,
  C1,
  C2,
  C_NEW,
  SPOOFED_UID,
  FOREIGN,
  G1,
  G2,
  G_NEW,
  T1,
  TG,
  GOOGLE_DIRTY_SENTINEL,
  contactPath,
  groupPath,
  vcardBody,
  groupVcardBody,
  put,
  get,
  del,
  writesTo,
  seedSettings,
} = H;

const CO1 = "0a0a0a0a-0b0b-4c0c-8d0d-0e0e0e0e0e0e";

H.setupCardDavHarness();

beforeEach(() => {
  // Ordering probe: the snapshot must land before the contacts UPDATE.
  fake.onUpdate("contacts", () => {
    ops.push("contacts_update");
  });
});

// A tiny but distinctive byte pattern; the tests only need determinism
// through encode → parse → sha256.
function photoBytes(seed: number): Uint8Array {
  const b = new Uint8Array(96);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function photoLine(bytes: Uint8Array): string {
  return `PHOTO;ENCODING=b;TYPE=JPEG:${base64(bytes)}`;
}

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
    // Frozen clock: the new revision is exactly "now", so the ETag the client
    // will store is fully determined.
    expect(res.headers.get("ETag")).toBe(contactETag(C_NEW, FIXED_ISO));

    const inserts = writesTo("inserts", "contacts");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload).toStrictEqual({
      // Ownership contract: identity comes from the URL + verified auth user,
      // never from what the client typed into the vCard body.
      id: C_NEW,
      user_id: USER,
      source: "carddav",
      updated_at: FIXED_ISO,
      email: null,
      name: "New Person",
    });
    // Brand new record: nothing to snapshot yet.
    expect(mocks.snapshotContact).not.toHaveBeenCalled();
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

  it("If-None-Match: * succeeds with 201 when the contact does not exist yet", async () => {
    const res = await put(contactPath(C_NEW), vcardBody(["FN:Fresh Person"], C_NEW), {
      "If-None-Match": "*",
    });
    expect(res.status).toBe(201);
    expect(writesTo("inserts", "contacts")).toHaveLength(1);
  });

  it("stale If-Match fails with 412 and writes nothing", async () => {
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy"]), {
      "If-Match": '"deadbeef-stale"',
    });
    expect(res.status).toBe(412);
    expect(writesTo("updates", "contacts")).toHaveLength(0);
    expect(mocks.snapshotContact).not.toHaveBeenCalled();
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

  it("a successful replace advances the ETag to the persisted updated_at", async () => {
    // iOS stores the PUT's ETag verbatim and compares it against the next
    // PROPFIND listing. If it did not advance, iOS would either re-fetch
    // needlessly or, worse, skip pushing a queued edit.
    const oldEtag = contactETag(C1, T1);
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Renamed"]));
    expect(res.status).toBe(204);

    const patch = writesTo("updates", "contacts")[0]!.payload as Record<string, unknown>;
    expect(patch.updated_at).toBe(FIXED_ISO);
    expect(res.headers.get("ETag")).toBe(contactETag(C1, FIXED_ISO));
    expect(res.headers.get("ETag")).not.toBe(oldEtag);
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
    expect(mocks.setContactEncryptedFields).not.toHaveBeenCalled();
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
    expect(dels[0]!.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "contact_id", value: C1 },
        { op: "eq", col: "user_id", value: USER },
      ]),
    );

    const inserts = writesTo("inserts", "contact_phones");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload).toStrictEqual([
      {
        user_id: USER,
        contact_id: C1,
        label: "mobile",
        number: "+1 (555) 111-2222",
        is_primary: true, // no PREF marker → first row becomes primary
        position: 0,
      },
      {
        user_id: USER,
        contact_id: C1,
        label: "work",
        number: "+1 555 333 4444",
        is_primary: false,
        position: 1,
      },
    ]);

    // The encrypted legacy phone column mirrors the primary number.
    expect(mocks.setContactEncryptedFields).toHaveBeenCalledWith({
      contact_id: C1,
      phone: "+1 (555) 111-2222",
    });
  });

  it("a vCard with EMAIL replaces all addresses, lowercased and primary-first", async () => {
    const res = await put(
      contactPath(C1),
      vcardBody([
        "FN:Erica Roy",
        "EMAIL;TYPE=INTERNET,WORK:Erica.Roy@Example.COM",
        "EMAIL;TYPE=INTERNET,HOME;PREF=1:Home.Erica@Example.COM",
      ]),
    );
    expect(res.status).toBe(204);

    const dels = writesTo("deletes", "contact_emails");
    expect(dels).toHaveLength(1);
    expect(dels[0]!.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "contact_id", value: C1 },
        { op: "eq", col: "user_id", value: USER },
      ]),
    );

    const inserts = writesTo("inserts", "contact_emails");
    expect(inserts).toHaveLength(1);
    // The parser sorts the PREF address first; addresses are stored folded
    // to lower case so the dedupe key and the Gmail lookup agree.
    expect(inserts[0]!.payload).toStrictEqual([
      {
        user_id: USER,
        contact_id: C1,
        label: "home",
        address: "home.erica@example.com",
        is_primary: true,
        position: 0,
      },
      {
        user_id: USER,
        contact_id: C1,
        label: "work",
        address: "erica.roy@example.com",
        is_primary: false,
        position: 1,
      },
    ]);

    // The legacy plaintext column mirrors the primary address.
    const patch = writesTo("updates", "contacts")[0]!.payload as Record<string, unknown>;
    expect(patch.email).toBe("home.erica@example.com");
  });

  it("a blank EMAIL slot never wipes stored emails or the email column", async () => {
    // Handler-level companion to sync.regression.test.ts: the parser drops
    // blank EMAIL slots, so the handler must neither touch contact_emails
    // nor include an `email` key in the contacts update.
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy", "EMAIL;TYPE=INTERNET:"]));
    expect(res.status).toBe(204);
    expect(writesTo("deletes", "contact_emails")).toHaveLength(0);
    expect(writesTo("inserts", "contact_emails")).toHaveLength(0);
    const patch = writesTo("updates", "contacts")[0]!.payload as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(patch, "email")).toBe(false);
  });

  it("NOTE is stripped of the AI summary block and ADR maps into encrypted lines", async () => {
    // The 🤖-summary block is server-owned: an iOS PUT echoes it back inside
    // NOTE and only the user's own text below the marker may be persisted.
    const res = await put(
      contactPath(C1),
      vcardBody([
        "FN:Erica Roy",
        "NOTE:🤖 Atzro summary\\nAI facts here\\n\\n— My notes —\\nkeep me",
        "ADR;TYPE=WORK:;;123 Main St;Springfield;IL;62704;USA",
      ]),
    );
    expect(res.status).toBe(204);
    expect(mocks.setContactEncryptedFields).toHaveBeenCalledWith({
      contact_id: C1,
      notes: "keep me",
      address_line1: "123 Main St",
      address_line2: "", // absent second line clears, per the ADR-present contract
    });
    // Plaintext city/region ride the contacts patch.
    const patch = writesTo("updates", "contacts")[0]!.payload as Record<string, unknown>;
    expect(patch).toMatchObject({ city: "Springfield", region: "IL", postal_code: "62704" });
  });
});

describe("PUT ORG → company resolution", () => {
  it("resolves ORG to a Company entity and carries company_id in the patch", async () => {
    mocks.resolveContactCompany.mockResolvedValue({ companyId: CO1 });
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy", "ORG:Acme Rockets"]));
    expect(res.status).toBe(204);

    expect(mocks.resolveContactCompany).toHaveBeenCalledTimes(1);
    expect(mocks.resolveContactCompany.mock.calls[0]![1]).toBe("Acme Rockets");

    const patch = writesTo("updates", "contacts")[0]!.payload as Record<string, unknown>;
    expect(patch).toMatchObject({ company: "Acme Rockets", company_id: CO1 });
  });

  it("does not resolve a company when the vCard carried no ORG line", async () => {
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy"]));
    expect(res.status).toBe(204);
    expect(mocks.resolveContactCompany).not.toHaveBeenCalled();
    const patch = writesTo("updates", "contacts")[0]!.payload as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(patch, "company_id")).toBe(false);
  });

  it("still saves the edit (204) when the company resolver throws", async () => {
    // Company linking is an enrichment: a resolver outage must not make the
    // iPhone believe its edit failed and retry forever.
    mocks.resolveContactCompany.mockRejectedValue(new Error("companies unavailable"));
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy", "ORG:Acme Rockets"]));
    expect(res.status).toBe(204);
    const patch = writesTo("updates", "contacts")[0]!.payload as Record<string, unknown>;
    expect(patch.company).toBe("Acme Rockets");
    expect(Object.prototype.hasOwnProperty.call(patch, "company_id")).toBe(false);
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "carddav.put.company_resolve_failed",
      expect.objectContaining({ contact_id: C1 }),
    );
  });
});

describe("PUT CATEGORIES reconciliation", () => {
  it("joins matched groups and leaves dropped ones, scoped to manual rows", async () => {
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
    expect(upserts[0]!.payload).toEqual([
      { group_id: G1, contact_id: C1, user_id: USER, auto_added: false },
    ]);
    expect(upserts[0]!.options).toEqual({
      onConflict: "group_id,contact_id",
      ignoreDuplicates: true,
    });

    // Only MANUAL rows are diffed away, scoped by auto_added=false.
    const dels = writesTo("deletes", "contact_group_members");
    expect(dels).toHaveLength(1);
    expect(dels[0]!.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "auto_added", value: false },
        { op: "in", col: "group_id", value: [G2] },
      ]),
    );
  });

  it("creates a genuinely new group through the shared label resolver", async () => {
    // Creation goes through resolveOrCreateCompanyLabel rather than a raw
    // insert so an inbound tag cannot mint a near-duplicate of a label some
    // other path created between our snapshot and now.
    mocks.resolveOrCreateCompanyLabel.mockResolvedValue({ id: G_NEW, name: "Prospects" });

    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy", "CATEGORIES:Prospects"]));
    expect(res.status).toBe(204);

    expect(mocks.resolveOrCreateCompanyLabel).toHaveBeenCalledTimes(1);
    expect(mocks.resolveOrCreateCompanyLabel.mock.calls[0]![1]).toMatchObject({
      rawName: "Prospects",
      parentGroupId: null,
    });
    const upserts = writesTo("upserts", "contact_group_members");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.payload).toEqual([
      { group_id: G_NEW, contact_id: C1, user_id: USER, auto_added: false },
    ]);
  });

  it("survives a failing group create: no membership write, still 204", async () => {
    mocks.resolveOrCreateCompanyLabel.mockRejectedValue(new Error("labels unavailable"));
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy", "CATEGORIES:Prospects"]));
    expect(res.status).toBe(204);
    expect(writesTo("upserts", "contact_group_members")).toHaveLength(0);
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "carddav.categories.group_create_failed",
      expect.objectContaining({ name: "Prospects" }),
    );
  });

  it("routes a merged-away company name to the surviving group via its alias", async () => {
    // A phone that synced before a company merge still tags contacts with
    // the old name. Resolving it through company_name_aliases is what stops
    // the merged-away group from resurrecting on every edit.
    fake.seed("companies", [{ id: CO1, user_id: USER, name: "Nissan" }]);
    fake.seed("company_name_aliases", [
      { user_id: USER, name_key: "nissan motor acceptance company", company_id: CO1 },
    ]);
    fake.seed("contact_groups", [
      {
        id: G1,
        user_id: USER,
        name: "Nissan",
        parent_group_id: null,
        auto_generated_from_group_id: null,
        auto_company_subgroups: false,
        updated_at: TG,
        carddav_uid: null,
      },
    ]);
    fake.seed("contact_group_members", []);

    const res = await put(
      contactPath(C1),
      vcardBody(["FN:Erica Roy", "CATEGORIES:Nissan Motor Acceptance Company"]),
    );
    expect(res.status).toBe(204);

    // Resolved to the surviving group — nothing new is created.
    expect(mocks.resolveOrCreateCompanyLabel).not.toHaveBeenCalled();
    const upserts = writesTo("upserts", "contact_group_members");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.payload).toEqual([
      { group_id: G1, contact_id: C1, user_id: USER, auto_added: false },
    ]);
  });
});

describe("PUT PHOTO", () => {
  it("skips an echo of the company logo we recorded when serving this contact", async () => {
    const bytes = photoBytes(7);
    const sha = await sha256Hex(bytes);
    fake.seed("contacts", [
      {
        id: C1,
        user_id: USER,
        updated_at: T1,
        email: "old@example.com",
        source: "google",
        company_logo_photo_sha: sha,
      },
    ]);

    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy", photoLine(bytes)]));
    expect(res.status).toBe(204);
    expect(mocks.saveContactPhoto).not.toHaveBeenCalled();
    expect(mocks.markGooglePhotoDirty).not.toHaveBeenCalled();
    // Cheap-first: the recorded sha alone decided it, so neither the avatar
    // bytes nor the live logo were fetched.
    expect(mocks.loadContactPhotoBytes).not.toHaveBeenCalled();
    expect(mocks.fetchChosenCompanyLogoBytes).not.toHaveBeenCalled();
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "carddav.put.photo_decision",
      expect.objectContaining({ contact_id: C1, reason: "skip_echo" }),
    );
  });

  it("skips a no-op re-PUT of the avatar already stored for this contact", async () => {
    const bytes = photoBytes(11);
    fake.seed("contacts", [
      {
        id: C1,
        user_id: USER,
        updated_at: T1,
        email: "old@example.com",
        source: "google",
        avatar_url: "https://storage.test/contact-photos/user-1/a.jpg",
      },
    ]);
    mocks.loadContactPhotoBytes.mockResolvedValue({ bytes, mime: "image/jpeg" });

    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy", photoLine(bytes)]));
    expect(res.status).toBe(204);
    expect(mocks.saveContactPhoto).not.toHaveBeenCalled();
    // A stored avatar means a GET would never inline a logo, so the live
    // logo fetch stays off the hot path.
    expect(mocks.fetchChosenCompanyLogoBytes).not.toHaveBeenCalled();
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "carddav.put.photo_decision",
      expect.objectContaining({ reason: "skip_noop" }),
    );
  });

  it("skips an echo of the logo a GET would inline today, even without a recorded sha", async () => {
    // The recorded fallback sha goes stale when the brand logo rotates; the
    // live comparison is the backstop that keeps the rotated logo from being
    // frozen into avatar_url.
    const bytes = photoBytes(13);
    mocks.resolveCompanyLogoDomainForContact.mockResolvedValue("acme.example");
    mocks.fetchChosenCompanyLogoBytes.mockResolvedValue({ bytes, mime: "image/png" });

    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy", photoLine(bytes)]));
    expect(res.status).toBe(204);
    expect(mocks.saveContactPhoto).not.toHaveBeenCalled();
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "carddav.put.photo_decision",
      expect.objectContaining({ reason: "skip_echo" }),
    );
  });

  it("saves a genuinely new picture as a user upload and resets the Google photo budget", async () => {
    // This is the branch the "photo reverts after a minute" bug lived in: a
    // picture the user deliberately picked matched nothing about THIS
    // contact, so it must be persisted — and stamped user_upload so the
    // getContact self-heal never strips it back out.
    const bytes = photoBytes(23);

    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy", photoLine(bytes)]));
    expect(res.status).toBe(204);
    expect(mocks.saveContactPhoto).toHaveBeenCalledTimes(1);
    expect(mocks.saveContactPhoto).toHaveBeenCalledWith(
      USER,
      C1,
      bytes,
      "image/jpeg",
      "user_upload",
    );
    expect(mocks.markGooglePhotoDirty).toHaveBeenCalledWith(USER, C1);
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "carddav.put.photo_decision",
      expect.objectContaining({ reason: "save" }),
    );
  });

  it("answers 500 with no ETag when storing the photo fails", async () => {
    // A 2xx here would hand iOS a fresh ETag for a contact whose next GET
    // has no photo — the client would quietly revert the picture the user
    // just set. A 5xx makes it keep its copy and retry.
    mocks.saveContactPhoto.mockRejectedValue(new Error("bucket unavailable"));

    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy", photoLine(photoBytes(31))]));
    expect(res.status).toBe(500);
    expect(res.headers.get("ETag")).toBeNull();
    // The failure aborts before the Google dirty-flag bridge.
    expect(writesTo("updates", "google_contact_links")).toHaveLength(0);
    expect(mocks.logError).toHaveBeenCalledWith(
      "carddav.put.photo_save_failed",
      expect.objectContaining({ contact_id: C1, user_id: USER }),
      expect.any(Error),
    );
  });

  it("ignores an empty PHOTO slot instead of clearing the stored picture", async () => {
    const res = await put(
      contactPath(C1),
      vcardBody(["FN:Erica Roy", "PHOTO;ENCODING=b;TYPE=JPEG:"]),
    );
    expect(res.status).toBe(204);
    expect(mocks.saveContactPhoto).not.toHaveBeenCalled();
    expect(mocks.logInfo).not.toHaveBeenCalledWith("carddav.put.photo_decision", expect.anything());
  });
});

describe("PUT DB failures", () => {
  it("returns 500 when the contacts UPDATE fails, before any dependent write", async () => {
    fake.onUpdate("contacts", () => ({ message: "update contacts failed" }));
    const res = await put(
      contactPath(C1),
      vcardBody(["FN:Erica Roy", "TEL;TYPE=CELL:+1 555 111 2222"]),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("update contacts failed");
    expect(mocks.setContactEncryptedFields).not.toHaveBeenCalled();
    expect(writesTo("deletes", "contact_phones")).toHaveLength(0);
  });

  it("returns 500 when the contacts INSERT fails", async () => {
    fake.onInsert("contacts", () => ({ message: "insert contacts failed" }));
    const res = await put(contactPath(C_NEW), vcardBody(["FN:New Person"], C_NEW));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("insert contacts failed");
  });

  it("returns 500 when the encrypted-field write fails", async () => {
    mocks.setContactEncryptedFields.mockResolvedValue({ error: "rpc denied" });
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy", "NOTE:hello"]));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("rpc denied");
    expect(writesTo("updates", "google_contact_links")).toHaveLength(0);
  });

  it("returns 500 when the phone rows cannot be cleared or reinserted", async () => {
    fake.onDelete("contact_phones", () => ({ message: "delete phones failed" }));
    const delRes = await put(
      contactPath(C1),
      vcardBody(["FN:Erica Roy", "TEL;TYPE=CELL:+1 555 111 2222"]),
    );
    expect(delRes.status).toBe(500);
    expect(writesTo("inserts", "contact_phones")).toHaveLength(0);

    fake.reset();
    H.seedBase();
    fake.onInsert("contact_phones", () => ({ message: "insert phones failed" }));
    const insRes = await put(
      contactPath(C1),
      vcardBody(["FN:Erica Roy", "TEL;TYPE=CELL:+1 555 111 2222"]),
    );
    expect(insRes.status).toBe(500);
    expect(await insRes.text()).toBe("insert phones failed");
  });

  it("returns 500 when the email rows cannot be cleared or reinserted", async () => {
    fake.onDelete("contact_emails", () => ({ message: "delete emails failed" }));
    const delRes = await put(
      contactPath(C1),
      vcardBody(["FN:Erica Roy", "EMAIL;TYPE=INTERNET:a@example.com"]),
    );
    expect(delRes.status).toBe(500);
    expect(writesTo("inserts", "contact_emails")).toHaveLength(0);

    fake.reset();
    H.seedBase();
    fake.onInsert("contact_emails", () => ({ message: "insert emails failed" }));
    const insRes = await put(
      contactPath(C1),
      vcardBody(["FN:Erica Roy", "EMAIL;TYPE=INTERNET:a@example.com"]),
    );
    expect(insRes.status).toBe(500);
    expect(await insRes.text()).toBe("insert emails failed");
  });

  it("returns 500 when the group UPDATE or INSERT fails", async () => {
    fake.onUpdate("contact_groups", () => ({ message: "update group failed" }));
    const upd = await put(groupPath(G1), groupVcardBody({ uid: `group-${G1}`, name: "Renamed" }));
    expect(upd.status).toBe(500);
    expect(await upd.text()).toBe("update group failed");
    expect(writesTo("deletes", "contact_group_members")).toHaveLength(0);

    fake.onInsert("contact_groups", () => ({ message: "insert group failed" }));
    const ins = await put(
      groupPath(G_NEW),
      groupVcardBody({ uid: `group-${G_NEW}`, name: "Fresh" }),
    );
    expect(ins.status).toBe(500);
    expect(await ins.text()).toBe("insert group failed");
  });
});

describe("PUT bookkeeping", () => {
  it("snapshots the previous state BEFORE the contacts update (restore safety net)", async () => {
    await put(contactPath(C1), vcardBody(["FN:Erica Roy"]));
    expect(mocks.snapshotContact).toHaveBeenCalledWith(USER, C1, "carddav_put");
    expect(ops.indexOf("snapshot")).toBeLessThan(ops.indexOf("contacts_update"));
  });

  it("flags the Google link dirty so the next two-way run pushes the CardDAV edit", async () => {
    await put(contactPath(C1), vcardBody(["FN:Erica Roy"]));
    const linkUpdates = writesTo("updates", "google_contact_links");
    expect(linkUpdates).toHaveLength(1);
    expect(linkUpdates[0]!.payload).toEqual({ last_synced_at: GOOGLE_DIRTY_SENTINEL });
    expect(linkUpdates[0]!.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "user_id", value: USER },
        { op: "eq", col: "contact_id", value: C1 },
      ]),
    );
  });

  it("keeps the edit when the follow-up reconcilers throw", async () => {
    // Subgroup reconciliation and rule replay are bookkeeping; failing them
    // must not turn a saved edit into a client-visible error.
    mocks.reconcileAutoParentsForContacts.mockRejectedValue(new Error("reconcile down"));
    mocks.applyRulesForContact.mockRejectedValue(new Error("rules down"));
    const res = await put(contactPath(C1), vcardBody(["FN:Erica Roy"]));
    expect(res.status).toBe(204);
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "carddav.put.auto_subgroup_reconcile_failed",
      expect.objectContaining({ contact_id: C1 }),
    );
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "carddav.put.rule_sync_failed",
      expect.objectContaining({ contact_id: C1 }),
    );
  });
});

describe("PUT group vCard", () => {
  it("creates the group and filters member UIDs down to contacts the user owns", async () => {
    const res = await put(
      groupPath(G_NEW),
      groupVcardBody({ uid: `group-${G_NEW}`, name: "VIPs", members: [C1, FOREIGN] }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("ETag")).toBe(groupETag(G_NEW, FIXED_ISO));

    const groupInserts = writesTo("inserts", "contact_groups");
    expect(groupInserts).toHaveLength(1);
    expect(groupInserts[0]!.payload).toMatchObject({
      id: G_NEW,
      user_id: USER,
      name: "VIPs",
      carddav_uid: `group-${G_NEW}`,
    });

    // Membership is set to exactly the OWNED member UIDs — the foreign
    // contact id must be dropped, never linked across users.
    const memberInserts = writesTo("inserts", "contact_group_members");
    expect(memberInserts).toHaveLength(1);
    expect(memberInserts[0]!.payload).toEqual([{ group_id: G_NEW, contact_id: C1, user_id: USER }]);
  });

  it("updates an existing group's name and replaces membership with owned members only", async () => {
    const res = await put(
      groupPath(G1),
      groupVcardBody({ uid: `group-${G1}`, name: "Renamed", members: [C1, FOREIGN] }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("ETag")).toBe(groupETag(G1, FIXED_ISO));
    expect(res.headers.get("ETag")).not.toBe(groupETag(G1, TG));
    expect(res.headers.get("Location")).toBe(
      `/api/public/carddav/${encodeURIComponent(EMAIL)}/contacts/group-${G1}.vcf`,
    );

    const updates = writesTo("updates", "contact_groups");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toStrictEqual({ name: "Renamed", updated_at: FIXED_ISO });

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

  it("accepts a current If-Match on a group and applies the rename", async () => {
    const res = await put(groupPath(G1), groupVcardBody({ uid: `group-${G1}`, name: "Renamed" }), {
      "If-Match": groupETag(G1, TG),
    });
    expect(res.status).toBe(204);
    expect(writesTo("updates", "contact_groups")).toHaveLength(1);
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

describe("GET / HEAD contact vCards", () => {
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
    expect(mocks.getContactDecrypted).not.toHaveBeenCalled();

    const weak = await get(contactPath(C1), { "If-None-Match": `W/${etag}` });
    expect(weak.status).toBe(304);
  });

  it("returns 304 for If-None-Match: * on an existing contact", async () => {
    const res = await get(contactPath(C1), { "If-None-Match": "*" });
    expect(res.status).toBe(304);
    expect(mocks.getContactDecrypted).not.toHaveBeenCalled();
  });

  it("honors a comma-separated If-None-Match list (RFC 9110 §13.1.2)", async () => {
    // Clients that keep several revisions in flight send them all; matching
    // any one of them is a cache hit.
    const res = await get(contactPath(C1), {
      "If-None-Match": `"stale-one", W/${contactETag(C1, T1)} , "stale-two"`,
    });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(contactETag(C1, T1));

    const miss = await get(contactPath(C1), { "If-None-Match": '"stale-one", "stale-two"' });
    expect(miss.status).toBe(200);
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

describe("GET group vCards", () => {
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

describe("GET company-logo fallback", () => {
  // loadContactPhotoOrLogo is the other half of the PUT echo guard: whatever
  // it serves it also fingerprints onto contacts.company_logo_photo_sha, and
  // that recorded sha is what lets the next PUT recognize an iOS echo.
  const LOGO = photoBytes(41);
  const OWN = photoBytes(42);

  beforeEach(() => {
    mocks.resolveCompanyLogoDomainForContact.mockResolvedValue("acme.example");
    mocks.fetchCompanyPhotoOrLogoBytes.mockResolvedValue({ bytes: LOGO, mime: "image/png" });
  });

  it("company_first inlines the company logo and records its full sha on the contact", async () => {
    seedSettings({ use_company_logo_fallback: true, photo_priority: "company_first" });
    mocks.loadContactPhotoBytes.mockResolvedValue({ bytes: OWN, mime: "image/jpeg" });

    const res = await get(contactPath(C1));
    expect(res.status).toBe(200);
    const body = await res.text();
    // company_first: the logo wins even though a personal photo exists.
    expect(body).toContain("PHOTO;ENCODING=b;TYPE=PNG:");

    const sha = await sha256Hex(LOGO);
    const shaWrites = writesTo("updates", "contacts").filter(
      (w) => (w.payload as { company_logo_photo_sha?: string }).company_logo_photo_sha === sha,
    );
    expect(shaWrites).toHaveLength(1);
    expect(shaWrites[0]!.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "id", value: C1 },
        { op: "eq", col: "user_id", value: USER },
      ]),
    );
    expect(mocks.recordCompanyLogoHash).toHaveBeenCalledWith({
      userId: USER,
      companyId: null,
      domain: "acme.example",
      sha256: sha,
      source: "carddav_inline",
    });
  });

  it("personal_first serves the stored photo and never fingerprints a logo", async () => {
    seedSettings({ use_company_logo_fallback: true, photo_priority: "personal_first" });
    mocks.loadContactPhotoBytes.mockResolvedValue({ bytes: OWN, mime: "image/jpeg" });

    const res = await get(contactPath(C1));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("PHOTO;ENCODING=b;TYPE=JPEG:");
    expect(mocks.fetchCompanyPhotoOrLogoBytes).not.toHaveBeenCalled();
    expect(mocks.recordCompanyLogoHash).not.toHaveBeenCalled();
  });

  it("personal_first still falls back to the company logo when no photo is stored", async () => {
    seedSettings({ use_company_logo_fallback: true, photo_priority: "personal_first" });

    const res = await get(contactPath(C1));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("PHOTO;ENCODING=b;TYPE=PNG:");
    expect(mocks.recordCompanyLogoHash).toHaveBeenCalledTimes(1);
  });

  it("the fallback preference off keeps the logo out of the vCard entirely", async () => {
    seedSettings({ use_company_logo_fallback: false, photo_priority: "company_first" });

    const res = await get(contactPath(C1));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("PHOTO");
    expect(mocks.fetchCompanyPhotoOrLogoBytes).not.toHaveBeenCalled();
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
    expect(tombs[0]!.payload).toStrictEqual({
      user_id: USER,
      resource_type: "contact",
      resource_id: C1,
      // Frozen clock: the 90-day prune horizon reads this exact stamp.
      deleted_at: FIXED_ISO,
    });
    expect(tombs[0]!.options).toEqual({ onConflict: "user_id,resource_type,resource_id" });
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

  it("rejects a non-UUID resource path with 400 before touching anything", async () => {
    const res = await del(`${EMAIL}/contacts/shortname.vcf`);
    expect(res.status).toBe(400);
    expect(fake.calls.deletes).toHaveLength(0);
    expect(writesTo("upserts", "carddav_tombstones")).toHaveLength(0);
  });

  it("returns 500 and lays no tombstone when the contact row cannot be deleted", async () => {
    fake.onDelete("contacts", () => ({ message: "delete contact failed" }));
    const res = await del(contactPath(C1));
    expect(res.status).toBe(500);
    expect(writesTo("upserts", "carddav_tombstones")).toHaveLength(0);
  });

  it("deletes a group with its memberships, sender_in_group filters, and a group tombstone", async () => {
    // Group deletes honor If-Match against the group ETag too.
    const res = await del(groupPath(G1), { "If-Match": groupETag(G1, TG) });
    expect(res.status).toBe(204);

    const memberDels = writesTo("deletes", "contact_group_members");
    expect(memberDels).toHaveLength(1);
    expect(memberDels[0]!.filters).toEqual(
      expect.arrayContaining([{ op: "eq", col: "group_id", value: G1 }]),
    );

    // Folder rules that referenced the group must not dangle.
    const filterDels = writesTo("deletes", "folder_filters");
    expect(filterDels).toHaveLength(1);
    expect(filterDels[0]!.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "op", value: "sender_in_group" },
        { op: "eq", col: "value", value: G1 },
      ]),
    );

    expect(writesTo("deletes", "contact_groups")).toHaveLength(1);
    const tombs = writesTo("upserts", "carddav_tombstones");
    expect(tombs[0]!.payload).toMatchObject({ resource_type: "group", resource_id: G1 });
  });

  it("refuses a group DELETE carrying a stale If-Match and leaves the group intact", async () => {
    const res = await del(groupPath(G1), { "If-Match": groupETag(G1, T1) });
    expect(res.status).toBe(412);
    expect(writesTo("deletes", "contact_groups")).toHaveLength(0);
    expect(writesTo("deletes", "contact_group_members")).toHaveLength(0);
    expect(writesTo("upserts", "carddav_tombstones")).toHaveLength(0);
    expect(fake.rows("contact_groups")).toHaveLength(1);
  });

  it("returns 404 for an already-gone group and lays no tombstone", async () => {
    const res = await del(groupPath(G_NEW));
    expect(res.status).toBe(404);
    expect(writesTo("deletes", "contact_groups")).toHaveLength(0);
    // No tombstone for a resource we never had — a spurious tombstone would
    // bump the CTag and 404 an unrelated href on every client's next sync.
    expect(writesTo("upserts", "carddav_tombstones")).toHaveLength(0);
  });

  it("deleting one contact leaves the other owned contact alone", async () => {
    await del(contactPath(C1));
    expect(fake.rows("contacts").map((r) => r.id)).toEqual([C2]);
  });
});
