// Tests for pushToGoogle: the write path from Zerrow contacts/groups to the
// Google People API. The mapper and the dirty check stay REAL; the People API
// client is stubbed per-function while `PeopleApiError` is kept as the REAL
// class (via importOriginal) so the SUT's instanceof checks keep working.
//
// Contracts protected here:
//   - dirty gating: a linked contact that is not dirty must generate ZERO
//     People API traffic (the cron runs every few minutes);
//   - the clobber guard: when Google holds emails Zerrow doesn't know, the
//     push is aborted, the link flips back to "trust remote", and the
//     missing addresses are imported additively — never overwritten;
//   - etag-conflict resilience: one conflicted contact must not stall the
//     rest of the batch;
//   - tombstones: a 404 from Google means "already gone" and must clear the
//     tombstone, while a 5xx must keep it for retry.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import type { LocalContact, Person } from "./mapper";

const fake = makeSupabaseFake();
const people = {
  createPerson: vi.fn(),
  updatePerson: vi.fn(),
  deletePerson: vi.fn(),
  getPerson: vi.fn(),
  createContactGroup: vi.fn(),
  updateContactGroup: vi.fn(),
  deleteContactGroup: vi.fn(),
  modifyGroupMembers: vi.fn(),
  updateContactPhoto: vi.fn(),
  getContactGroupWithMembers: vi.fn(),
};
const loadLocalContactMock = vi.fn();
const loadContactPhotoBytesMock = vi.fn();
const resolvePhotoMock = vi.fn();
const logInfoMock = vi.fn();
const logErrorMock = vi.fn();

// CRITICAL: factories must not touch module-level consts at factory time
// (vi.mock hoisting) — every property access is deferred into method bodies.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));
vi.mock("@/lib/google-oauth.server", () => ({
  getAccessToken: async () => "test-token",
  NeedsReconnectError: class NeedsReconnectError extends Error {},
}));
vi.mock("./people-client.server", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./people-client.server")>();
  return {
    ...orig, // keeps the REAL PeopleApiError so instanceof checks work
    createPerson: (...args: unknown[]) => people.createPerson(...args),
    updatePerson: (...args: unknown[]) => people.updatePerson(...args),
    deletePerson: (...args: unknown[]) => people.deletePerson(...args),
    getPerson: (...args: unknown[]) => people.getPerson(...args),
    createContactGroup: (...args: unknown[]) => people.createContactGroup(...args),
    updateContactGroup: (...args: unknown[]) => people.updateContactGroup(...args),
    deleteContactGroup: (...args: unknown[]) => people.deleteContactGroup(...args),
    modifyGroupMembers: (...args: unknown[]) => people.modifyGroupMembers(...args),
    updateContactPhoto: (...args: unknown[]) => people.updateContactPhoto(...args),
    getContactGroupWithMembers: (...args: unknown[]) => people.getContactGroupWithMembers(...args),
  };
});
vi.mock("./state.server", () => ({
  loadLocalContact: (contactId: string) => loadLocalContactMock(contactId),
}));
vi.mock("@/lib/contacts/photos.server", () => ({
  loadContactPhotoBytes: (url: string | null) => loadContactPhotoBytesMock(url),
}));
// The photo lane resolves effective bytes (own avatar, company logo, or domain
// logo) through this module, dynamically imported inside the push loop.
vi.mock("@/lib/contacts/logo-photo.server", () => ({
  resolveEffectiveContactPhotoForSync: (userId: string, contactId: string) =>
    resolvePhotoMock(userId, contactId),
}));
vi.mock("@/lib/log.server", () => ({
  logInfo: (...args: unknown[]) => logInfoMock(...args),
  logError: (...args: unknown[]) => logErrorMock(...args),
}));

import { pushToGoogle, formatGoogleLabelName } from "./push.server";
import { MAX_PHOTO_PUSH_ATTEMPTS } from "./dirty";
import { PeopleApiError } from "./people-client.server";
import { SUMMARY_HEADING } from "@/lib/carddav/vcard";

const USER = "user-1";
const ACC = "acct-1";
const IDS = { userId: USER, gmailAccountId: ACC, runId: "run-1" };

const CT1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CT2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const G1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const G2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const OLD = "2026-07-01T00:00:00.000Z";
const NEWER = "2026-07-02T00:00:00.000Z";
const EPOCH = "1970-01-01T00:00:00.000Z";

function localContact(id: string): LocalContact {
  return {
    id,
    email: "pat@example.com",
    name: "Pat Example",
    title: null,
    company: null,
    website: null,
    linkedin: null,
    twitter: null,
    address_line1: null,
    address_line2: null,
    city: null,
    region: null,
    postal_code: null,
    country: null,
    notes: "my own note",
    relationship_summary: "AI facts",
    primary_phone: null,
  };
}

// Accumulating seed helper: `fake.seed` replaces a table wholesale, so we
// keep the rows added so far and re-seed the union on every call.
let currentContacts: Array<Record<string, unknown>> = [];
function seedContact(id: string, updatedAt: string, avatarUrl: string | null = null): void {
  currentContacts.push({
    id,
    user_id: USER,
    email: "pat@example.com",
    updated_at: updatedAt,
    avatar_url: avatarUrl,
  });
  fake.seed("contacts", currentContacts);
}

// A link whose photo lane is already settled: `photo_etag` is non-null (so the
// photo-dirty pass skips it) and matches the default resolver etag (so a
// visited contact issues no photo write). Photo tests override `photo_etag`
// with null to opt INTO the photo lane.
const SETTLED_PHOTO = "settled-photo-etag";

function link(contactId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: USER,
    gmail_account_id: ACC,
    contact_id: contactId,
    resource_name: `people/${contactId.slice(0, 8)}`,
    etag: "etag-old",
    last_synced_at: OLD,
    photo_etag: SETTLED_PHOTO,
    photo_push_attempts: 0,
    google_photo_url: null,
    ...over,
  };
}

function writesTo(kind: "inserts" | "updates" | "deletes" | "upserts", table: string) {
  return fake.calls[kind].filter((w) => w.table === table);
}

beforeEach(() => {
  fake.reset();
  currentContacts = [];
  vi.clearAllMocks();
  loadLocalContactMock.mockImplementation(async (id: string) => localContact(id));
  loadContactPhotoBytesMock.mockResolvedValue(null);
  // Default: the resolved photo matches what was last pushed, so the photo
  // lane is a no-op unless a test opts in.
  resolvePhotoMock.mockResolvedValue({
    bytes: new Uint8Array([9, 9, 9]),
    etag: SETTLED_PHOTO,
    source: "contact_avatar",
    avatarUrl: null,
    companyId: null,
    companyLogoUrl: null,
    domain: null,
  });
  // Default: guard fetch sees a remote with no emails at all (never trips).
  people.getPerson.mockResolvedValue({ etag: "etag-remote", emailAddresses: [] });
  people.updatePerson.mockResolvedValue({ etag: "etag-updated" });
  people.createPerson.mockResolvedValue({ resourceName: "people/new", etag: "etag-created" });
  // Default: no remote memberships, so the membership pass is a no-op unless a
  // test opts in — keeps the group create/rename cases isolated from it.
  people.getContactGroupWithMembers.mockResolvedValue({ memberResourceNames: [] });
});

describe("pushContacts dirty gating", () => {
  it("makes zero People API calls when the contact is clean in both lanes", async () => {
    // Body-clean (synced after its last edit) AND photo-settled (non-null
    // photo_etag) — the cron runs every few minutes, so a steady-state
    // account must generate no Google traffic at all.
    seedContact(CT1, OLD);
    fake.seed("google_contact_links", [link(CT1, { last_synced_at: NEWER })]);

    const res = await pushToGoogle(IDS);

    expect(res.contactsPushed).toBe(0);
    expect(loadLocalContactMock).not.toHaveBeenCalled();
    expect(people.getPerson).not.toHaveBeenCalled();
    expect(people.updatePerson).not.toHaveBeenCalled();
    expect(people.createPerson).not.toHaveBeenCalled();
  });

  it("visits a body-clean contact whose photo has never been pushed", async () => {
    // The photo lane is deliberately independent of updated_at: a link with a
    // null photo_etag has never had its photo resolved, so it must still be
    // visited (company/domain logos exist even with no own avatar).
    seedContact(CT1, OLD);
    fake.seed("google_contact_links", [link(CT1, { last_synced_at: NEWER, photo_etag: null })]);

    const res = await pushToGoogle(IDS);

    expect(loadLocalContactMock).toHaveBeenCalledWith(CT1);
    expect(resolvePhotoMock).toHaveBeenCalledWith(USER, CT1);
    expect(people.updateContactPhoto).toHaveBeenCalledTimes(1);
    // Selection is per-contact, not per-lane: once the photo lane pulls a
    // contact in, its body is pushed in the same visit (etag-protected).
    expect(people.updatePerson).toHaveBeenCalledTimes(1);
    expect(res.contactsPushed).toBe(1);
  });

  it("stops visiting a contact once the photo retry budget is exhausted", async () => {
    seedContact(CT1, OLD);
    fake.seed("google_contact_links", [
      link(CT1, {
        last_synced_at: NEWER,
        photo_etag: null,
        photo_push_attempts: MAX_PHOTO_PUSH_ATTEMPTS,
      }),
    ]);

    const res = await pushToGoogle(IDS);

    // Body-clean and past the photo cap → no work, no Google traffic.
    expect(res.contactsPushed).toBe(0);
    expect(resolvePhotoMock).not.toHaveBeenCalled();
    expect(people.updateContactPhoto).not.toHaveBeenCalled();
  });
});

describe("pushContacts clobber guard", () => {
  it("aborts the push, flips the link to trust-remote, and imports remote-only emails additively", async () => {
    seedContact(CT1, NEWER);
    fake.seed("google_contact_links", [link(CT1)]);
    fake.seed("contact_emails", [
      { contact_id: CT1, address: "local@example.com", position: 0, is_primary: true },
    ]);
    people.getPerson.mockResolvedValue({
      etag: "etag-remote",
      emailAddresses: [{ value: " Extra@Remote.com " }],
    });

    const res = await pushToGoogle(IDS);

    // The local body must NOT overwrite Google while Google knows more.
    expect(people.updatePerson).not.toHaveBeenCalled();
    expect(res.contactsPushed).toBe(0);

    // Trust-remote flip: epoch last_synced_at makes the next pull win.
    const linkUpdates = writesTo("updates", "google_contact_links");
    expect(linkUpdates).toHaveLength(1);
    expect(linkUpdates[0].payload).toEqual({ etag: "etag-remote", last_synced_at: EPOCH });

    // The remote-only address lands immediately, lowercased and additive:
    // the existing primary keeps its flag, position continues after max.
    const inserts = writesTo("inserts", "contact_emails");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toEqual([
      {
        user_id: USER,
        contact_id: CT1,
        label: "other",
        address: "extra@remote.com",
        is_primary: false,
        position: 1,
      },
    ]);
  });

  it("a transient guard-fetch error falls through to the normal etag-protected update", async () => {
    seedContact(CT1, NEWER);
    fake.seed("google_contact_links", [link(CT1)]);
    people.getPerson.mockRejectedValue(new Error("network blip"));

    const res = await pushToGoogle(IDS);

    // The guard failing must not block the push — the etag on the update
    // body still protects against silent overwrites.
    expect(people.updatePerson).toHaveBeenCalledTimes(1);
    const [, , body] = people.updatePerson.mock.calls[0] as [string, string, { etag: string }];
    expect(body.etag).toBe("etag-old");
    expect(res.contactsPushed).toBe(1);
    expect(logErrorMock).toHaveBeenCalledWith(
      "google_contacts.push.guard_failed",
      expect.objectContaining({ contact_id: CT1 }),
      expect.anything(),
    );
  });

  it("an etag conflict skips that contact and continues with the rest of the batch", async () => {
    seedContact(CT1, NEWER);
    seedContact(CT2, NEWER);
    fake.seed("google_contact_links", [link(CT1), link(CT2)]);
    people.updatePerson
      .mockRejectedValueOnce(new PeopleApiError("People API 400: FAILED_PRECONDITION", 400))
      .mockResolvedValueOnce({ etag: "etag-updated" });

    const res = await pushToGoogle(IDS);

    expect(people.updatePerson).toHaveBeenCalledTimes(2);
    expect(res.contactsPushed).toBe(1);
    expect(logInfoMock).toHaveBeenCalledWith(
      "google_contacts.push.etag_conflict_skip",
      expect.objectContaining({ contact_id: CT1 }),
    );
  });
});

describe("pushContacts create + note preference", () => {
  it("creates unlinked contacts and records the link with the composite onConflict key", async () => {
    seedContact(CT1, NEWER);
    fake.seed("google_contact_links", []);

    const res = await pushToGoogle(IDS);

    expect(people.createPerson).toHaveBeenCalledTimes(1);
    const upserts = writesTo("upserts", "google_contact_links");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload).toMatchObject({
      user_id: USER,
      gmail_account_id: ACC,
      contact_id: CT1,
      resource_name: "people/new",
      etag: "etag-created",
    });
    expect(upserts[0].options).toEqual({ onConflict: "gmail_account_id,contact_id" });
    expect(res.contactsPushed).toBe(1);

    // Default preference: the AI summary IS folded into the pushed note.
    const [, body] = people.createPerson.mock.calls[0] as [string, Partial<Person>];
    expect(body.biographies?.[0]?.value).toContain(SUMMARY_HEADING);
  });

  it("include_summary_in_notes=false pushes only the user's own note text", async () => {
    seedContact(CT1, NEWER);
    fake.seed("carddav_settings", [{ user_id: USER, include_summary_in_notes: false }]);

    await pushToGoogle(IDS);

    const [, body] = people.createPerson.mock.calls[0] as [string, Partial<Person>];
    expect(body.biographies?.[0]?.value).toBe("my own note");
    expect(body.biographies?.[0]?.value).not.toContain(SUMMARY_HEADING);
  });
});

describe("pushContacts photo push", () => {
  const bytes = new Uint8Array([1, 2, 3]);

  function photo(etag: string) {
    return {
      bytes,
      etag,
      source: "contact_avatar",
      avatarUrl: etag,
      companyId: null,
      companyLogoUrl: null,
      domain: null,
    };
  }

  it("uploads and records the new etag when the resolved photo differs from photo_etag", async () => {
    // Body-clean (synced after its last edit) but photo-dirty (null photo_etag)
    // so ONLY the photo lane runs — no body update to muddy the assertion.
    seedContact(CT1, OLD, "avatars/a.png");
    fake.seed("google_contact_links", [link(CT1, { last_synced_at: NEWER, photo_etag: null })]);
    resolvePhotoMock.mockResolvedValue(photo("avatars/a.png"));

    await pushToGoogle(IDS);

    expect(people.updateContactPhoto).toHaveBeenCalledTimes(1);
    expect(people.updateContactPhoto).toHaveBeenCalledWith(ACC, `people/${CT1.slice(0, 8)}`, bytes);
    const photoUpdates = writesTo("updates", "google_contact_links").filter(
      (u) => (u.payload as Record<string, unknown>).photo_etag !== undefined,
    );
    expect(photoUpdates).toHaveLength(1);
    // A successful upload records the new etag and clears the failure state.
    expect(photoUpdates[0].payload).toMatchObject({
      photo_etag: "avatars/a.png",
      photo_push_attempts: 0,
      last_photo_error: null,
    });
  });

  it("skips the upload when the resolved photo etag equals the last pushed one", async () => {
    // A body-dirty contact IS visited (its body is pushed), but the photo lane
    // must not re-upload bytes Google already has — the inner etag gate.
    seedContact(CT1, NEWER, "avatars/a.png");
    fake.seed("google_contact_links", [link(CT1, { photo_etag: "avatars/a.png" })]);
    resolvePhotoMock.mockResolvedValue(photo("avatars/a.png"));

    await pushToGoogle(IDS);

    expect(people.updateContactPhoto).not.toHaveBeenCalled();
    const photoUpdates = writesTo("updates", "google_contact_links").filter(
      (u) => (u.payload as Record<string, unknown>).photo_etag !== undefined,
    );
    expect(photoUpdates).toHaveLength(0);
  });

  it("marks a contact with no resolvable photo so it stops being photo-dirty", async () => {
    seedContact(CT1, NEWER);
    fake.seed("google_contact_links", [link(CT1, { photo_etag: null })]);
    resolvePhotoMock.mockResolvedValue(null);

    await pushToGoogle(IDS);

    expect(people.updateContactPhoto).not.toHaveBeenCalled();
    const photoUpdates = writesTo("updates", "google_contact_links").filter(
      (u) => (u.payload as Record<string, unknown>).photo_etag !== undefined,
    );
    // A sentinel etag retires the photo-dirty flag; without it the contact
    // would be re-visited by the photo lane on every single cron tick.
    expect(photoUpdates).toHaveLength(1);
    expect(photoUpdates[0].payload).toMatchObject({ photo_push_attempts: 0 });
    expect((photoUpdates[0].payload as Record<string, unknown>).photo_etag).toBeTruthy();
  });

  it("bumps the attempt counter and keeps photo_etag when the upload fails", async () => {
    seedContact(CT1, NEWER, "avatars/a.png");
    fake.seed("google_contact_links", [link(CT1, { photo_etag: null, photo_push_attempts: 1 })]);
    resolvePhotoMock.mockResolvedValue(photo("avatars/a.png"));
    people.updateContactPhoto.mockRejectedValue(new PeopleApiError("photo boom", 500));

    await pushToGoogle(IDS);

    const photoUpdates = writesTo("updates", "google_contact_links").filter(
      (u) => (u.payload as Record<string, unknown>).photo_push_attempts !== undefined,
    );
    expect(photoUpdates).toHaveLength(1);
    // photo_etag stays unset so the next run retries; the counter advances
    // toward the give-up cap.
    expect(photoUpdates[0].payload).toMatchObject({
      photo_push_attempts: 2,
      last_photo_status: 500,
    });
    expect((photoUpdates[0].payload as Record<string, unknown>).photo_etag).toBeUndefined();
  });
});

describe("pushGroups", () => {
  it("creates a Google label for an unlinked group and stores the link", async () => {
    fake.seed("contact_groups", [{ id: G1, user_id: USER, name: "Clients", updated_at: NEWER }]);
    people.createContactGroup.mockResolvedValue({
      resourceName: "contactGroups/g1",
      etag: "g-etag",
    });

    const res = await pushToGoogle(IDS);

    expect(people.createContactGroup).toHaveBeenCalledWith(ACC, "Clients");
    const inserts = writesTo("inserts", "google_group_links");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toMatchObject({
      user_id: USER,
      gmail_account_id: ACC,
      contact_group_id: G1,
      resource_name: "contactGroups/g1",
      etag: "g-etag",
    });
    expect(res.groupsPushed).toBe(1);
  });

  it("renames only groups edited since last sync; fresh links are skipped", async () => {
    fake.seed("contact_groups", [
      { id: G1, user_id: USER, name: "Renamed", updated_at: NEWER },
      { id: G2, user_id: USER, name: "Stable", updated_at: OLD },
    ]);
    fake.seed("google_group_links", [
      {
        contact_group_id: G1,
        gmail_account_id: ACC,
        resource_name: "contactGroups/g1",
        etag: "e1",
        last_synced_at: OLD,
      },
      {
        contact_group_id: G2,
        gmail_account_id: ACC,
        resource_name: "contactGroups/g2",
        etag: "e2",
        last_synced_at: NEWER, // synced after its last edit → skip
      },
    ]);
    people.updateContactGroup.mockResolvedValue({ etag: "e1-new" });

    const res = await pushToGoogle(IDS);

    expect(people.updateContactGroup).toHaveBeenCalledTimes(1);
    // The current etag is passed so Google can reject a stale-write conflict.
    expect(people.updateContactGroup).toHaveBeenCalledWith(
      ACC,
      "contactGroups/g1",
      "Renamed",
      "e1",
    );
    expect(people.createContactGroup).not.toHaveBeenCalled();
    expect(res.groupsPushed).toBe(1);
  });
});

describe("formatGoogleLabelName", () => {
  it("prefixes a nested group's label with its parent, idempotently", () => {
    const parents = new Map([[G2, "Clients"]]);
    // Top-level group → unchanged.
    expect(formatGoogleLabelName("Leads", null, parents)).toBe("Leads");
    // Nested group → "Parent - Child".
    expect(formatGoogleLabelName("VIP", G2, parents)).toBe("Clients - VIP");
    // Already-prefixed name is not double-prefixed (re-push stability).
    expect(formatGoogleLabelName("Clients - VIP", G2, parents)).toBe("Clients - VIP");
    // Unknown parent id → fall back to the bare name rather than "undefined - ".
    expect(formatGoogleLabelName("VIP", "missing", parents)).toBe("VIP");
  });
});

describe("pushGroupMemberships remote-member guard", () => {
  function seedOneGroupWithRemoteMembers(remoteMembers: string[]): void {
    fake.seed("google_group_links", [
      { contact_group_id: G1, gmail_account_id: ACC, resource_name: "contactGroups/g1" },
    ]);
    // CT1 is linked and locally a member; CT2 is linked but NOT a member.
    fake.seed("google_contact_links", [
      link(CT1, { resource_name: "people/ct1" }),
      link(CT2, { resource_name: "people/ct2" }),
    ]);
    fake.seed("contact_group_members", [{ group_id: G1, contact_id: CT1 }]);
    // Key by resource: myContacts already holds both linked contacts (so the
    // promoteToMyContacts pass is a no-op and doesn't add a second
    // modifyGroupMembers call), while the group under test returns the fixture.
    people.getContactGroupWithMembers.mockImplementation(async (_acc: string, resource: string) =>
      resource === "contactGroups/g1"
        ? { memberResourceNames: remoteMembers }
        : { memberResourceNames: ["people/ct1", "people/ct2"] },
    );
  }

  function groupModifyCall() {
    return (
      people.modifyGroupMembers.mock.calls as Array<[string, string, string[], string[]]>
    ).find((c) => c[1] === "contactGroups/g1");
  }

  it("never removes a remote member Zerrow hasn't linked yet", async () => {
    // Google has an unknown member (people/stranger) plus our linked-but-
    // non-member CT2. Only CT2 (known, not desired) may be removed; the
    // stranger must be left untouched or every push cycle would strip it.
    seedOneGroupWithRemoteMembers(["people/ct2", "people/stranger"]);

    await pushToGoogle(IDS);

    const call = groupModifyCall();
    expect(call).toBeDefined();
    const [, , toAdd, toRemove] = call!;
    expect(toAdd).toEqual(["people/ct1"]); // desired but absent remotely
    expect(toRemove).toEqual(["people/ct2"]); // known + not desired
    expect(toRemove).not.toContain("people/stranger");
  });

  it("issues no group membership change when the known remote set already matches", async () => {
    // Remote holds the one desired member (ct1) plus an unlinked stranger the
    // guard filters out → nothing to add or remove for this group.
    seedOneGroupWithRemoteMembers(["people/ct1", "people/stranger"]);

    await pushToGoogle(IDS);

    expect(groupModifyCall()).toBeUndefined();
  });
});

describe("applyTombstones", () => {
  it("clears the tombstone on success AND on 404 (already gone upstream)", async () => {
    fake.seed("google_contact_tombstones", [
      { id: "t1", kind: "contact", resource_name: "people/x", gmail_account_id: ACC },
      { id: "t2", kind: "group", resource_name: "contactGroups/y", gmail_account_id: ACC },
    ]);
    people.deletePerson.mockResolvedValue(undefined);
    people.deleteContactGroup.mockRejectedValue(new PeopleApiError("gone", 404));

    const res = await pushToGoogle(IDS);

    expect(res.tombstonesApplied).toBe(2);
    const dels = writesTo("deletes", "google_contact_tombstones");
    expect(dels).toHaveLength(2);
    const deletedIds = dels.map((d) => d.filters.find((f) => f.col === "id")?.value);
    expect(deletedIds).toEqual(expect.arrayContaining(["t1", "t2"]));
  });

  it("keeps the tombstone for retry when Google returns a 5xx", async () => {
    fake.seed("google_contact_tombstones", [
      { id: "t1", kind: "contact", resource_name: "people/x", gmail_account_id: ACC },
    ]);
    people.deletePerson.mockRejectedValue(new PeopleApiError("boom", 500));

    const res = await pushToGoogle(IDS);

    expect(res.tombstonesApplied).toBe(0);
    expect(writesTo("deletes", "google_contact_tombstones")).toHaveLength(0);
    expect(logErrorMock).toHaveBeenCalledWith(
      "google_contacts.push.tombstone_failed",
      expect.objectContaining({ resource_name: "people/x" }),
      expect.anything(),
    );
  });
});
