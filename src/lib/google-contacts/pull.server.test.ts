// Tests for pullFromGoogle: the read path from the Google People API into
// Atzro contacts/groups. The mapper, the dirty check, and the photo-pull
// decision stay REAL; the People API client is stubbed per-function while
// `PeopleApiError` is kept as the REAL class (via importOriginal) so the SUT's
// instanceof checks keep working.
//
// Contracts protected here:
//   - page cursoring: every nextPageToken is followed and the LAST page's
//     nextSyncToken is what gets returned for storage;
//   - syncToken flow: a stored token makes the pull incremental; an
//     EXPIRED_SYNC_TOKEN restarts a FULL pull and discards partial pages;
//   - dirty gating: a locally-edited contact (updated_at > last_synced_at) is
//     never overwritten by a pull — only its remote etag is refreshed;
//   - merge policy: merging into an existing contact (by email or phone) does
//     NOT overwrite its plaintext columns, while an already-linked contact IS
//     hard-overwritten field-by-field (missing Google fields become null,
//     except `email`, which is only written when Google has one);
//   - photo pull: bytes are refetched only when Google's signed URL changed,
//     user-chosen photos are never replaced, known company logos are skipped;
//   - partial failure: one bad person row must not abort the rest of a batch.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import type { Person } from "./mapper";
import type { SyncState } from "./state.server";

const fake = makeSupabaseFake();
const people = {
  listConnectionsPage: vi.fn(),
  listContactGroupsPage: vi.fn(),
  fetchPhotoBytes: vi.fn(),
};
const loadSyncStateMock = vi.fn();
const updateSyncStateMock = vi.fn();
const ensureSyncStateMock = vi.fn();
const setContactEncryptedFieldsMock = vi.fn();
const resolveOrCreateCompanyLabelMock = vi.fn();
const loadNameAliasMapMock = vi.fn();
const resolveContactCompanyMock = vi.fn();
const findEmaillessDuplicateMock = vi.fn();
const saveContactPhotoMock = vi.fn();
const sha256HexMock = vi.fn();
const buildKnownLogoShaSetMock = vi.fn();
const reconcileAutoParentsMock = vi.fn();
const syncCompanyRuleMembershipsMock = vi.fn();
const logInfoMock = vi.fn();
const logErrorMock = vi.fn();

// CRITICAL: factories must not touch module-level consts at factory time
// (vi.mock hoisting) — every property access is deferred into method bodies.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));
vi.mock("@/lib/google-oauth.server", () => ({
  getAccessToken: async () => "test-token",
  NeedsReconnectError: class NeedsReconnectError extends Error {},
}));
vi.mock("./people-client.server", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./people-client.server")>();
  return {
    ...orig, // keeps the REAL PeopleApiError so instanceof checks work
    listConnectionsPage: (...args: unknown[]) => people.listConnectionsPage(...args),
    listContactGroupsPage: (...args: unknown[]) => people.listContactGroupsPage(...args),
    fetchPhotoBytes: (...args: unknown[]) => people.fetchPhotoBytes(...args),
  };
});
vi.mock("./state.server", () => ({
  loadSyncState: (userId: string, acc: string) => loadSyncStateMock(userId, acc),
  updateSyncState: (id: string, patch: unknown) => updateSyncStateMock(id, patch),
  ensureSyncState: (userId: string, acc: string) => ensureSyncStateMock(userId, acc),
}));
vi.mock("@/lib/sync/encrypted-writer", () => ({
  setContactEncryptedFields: (input: unknown) => setContactEncryptedFieldsMock(input),
}));
vi.mock("@/lib/contacts/label-resolve.server", () => ({
  resolveOrCreateCompanyLabel: (ctx: unknown, args: unknown) =>
    resolveOrCreateCompanyLabelMock(ctx, args),
  loadNameAliasMap: (ctx: unknown) => loadNameAliasMapMock(ctx),
}));
vi.mock("@/lib/companies/resolve.server", () => ({
  resolveContactCompany: (ctx: unknown, text: unknown, cache: unknown) =>
    resolveContactCompanyMock(ctx, text, cache),
}));
vi.mock("@/lib/contacts/dedup.server", () => ({
  findEmaillessDuplicate: (input: unknown) => findEmaillessDuplicateMock(input),
}));
vi.mock("@/lib/contacts/photos.server", () => ({
  saveContactPhoto: (...args: unknown[]) => saveContactPhotoMock(...args),
  sha256Hex: (bytes: Uint8Array) => sha256HexMock(bytes),
}));
vi.mock("@/lib/contacts/known-logos.server", () => ({
  buildKnownCompanyLogoShaSet: (userId: string) => buildKnownLogoShaSetMock(userId),
}));
vi.mock("@/lib/contacts/auto-company-subgroups.functions", () => ({
  reconcileAutoParentsForContacts: (...args: unknown[]) => reconcileAutoParentsMock(...args),
}));
vi.mock("@/lib/contacts/group-rules.functions", () => ({
  syncCompanyRuleMemberships: (...args: unknown[]) => syncCompanyRuleMembershipsMock(...args),
}));
vi.mock("@/lib/log.server", () => ({
  logInfo: (...args: unknown[]) => logInfoMock(...args),
  logError: (...args: unknown[]) => logErrorMock(...args),
}));

import { pullFromGoogle, forceFullResync } from "./pull.server";
import { PeopleApiError } from "./people-client.server";

const USER = "user-1";
const ACC = "acct-1";
const IDS = { userId: USER, gmailAccountId: ACC, runId: "run-1" };

const CT1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CT2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GC_AUTO = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const G_LOCAL = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const OLD = "2026-07-01T00:00:00.000Z";
const NEWER = "2026-07-02T00:00:00.000Z";

function stateRow(over: Partial<SyncState> = {}): SyncState {
  return {
    id: "state-1",
    user_id: USER,
    gmail_account_id: ACC,
    enabled: true,
    sync_mode: "two_way",
    people_sync_token: null,
    groups_sync_token: null,
    last_full_sync_at: null,
    last_incremental_at: null,
    last_error: null,
    last_pull_count: 0,
    last_push_count: 0,
    pending_bump: false,
    locked_at: null,
    progress_step: null,
    progress_processed: 0,
    progress_total: 0,
    progress_updated_at: null,
    last_pull_created: 0,
    last_pull_updated: 0,
    last_pull_skipped_no_email: 0,
    last_pull_merged: 0,
    last_pull_failed: 0,
    sync_interval_minutes: 15,
    ...over,
  };
}

function person(resourceName: string, over: Partial<Person> = {}): Person {
  return { resourceName, etag: `etag-${resourceName}`, ...over };
}

function seedContact(id: string, over: Record<string, unknown> = {}): void {
  fake.seed("contacts", [
    { id, user_id: USER, email: "pat@example.com", updated_at: OLD, avatar_source: null, ...over },
  ]);
}

function contactLink(
  contactId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    user_id: USER,
    gmail_account_id: ACC,
    contact_id: contactId,
    resource_name: `people/${contactId.slice(0, 8)}`,
    etag: "etag-old",
    last_synced_at: NEWER, // clean by default (synced after the last local edit)
    google_photo_url: null,
    ...over,
  };
}

function writesTo(kind: "inserts" | "updates" | "deletes" | "upserts", table: string) {
  return fake.calls[kind].filter((w) => w.table === table);
}

/** The stamping upsert that closes out each applied person. */
function finalLinkUpserts() {
  return writesTo("upserts", "google_contact_links").filter(
    (u) => (u.payload as Record<string, unknown>).last_synced_at !== undefined,
  );
}

beforeEach(() => {
  fake.reset();
  loadSyncStateMock.mockResolvedValue(stateRow());
  ensureSyncStateMock.mockResolvedValue(stateRow());
  updateSyncStateMock.mockResolvedValue(undefined);
  people.listContactGroupsPage.mockResolvedValue({ contactGroups: [], nextSyncToken: "gtok-1" });
  people.listConnectionsPage.mockResolvedValue({ connections: [], nextSyncToken: "ptok-1" });
  people.fetchPhotoBytes.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" });
  setContactEncryptedFieldsMock.mockResolvedValue({ error: null });
  resolveContactCompanyMock.mockResolvedValue({ companyId: null, canonicalName: null });
  findEmaillessDuplicateMock.mockResolvedValue(null);
  loadNameAliasMapMock.mockResolvedValue(new Map());
  resolveOrCreateCompanyLabelMock.mockResolvedValue({
    id: G_LOCAL,
    name: "Resolved",
    created: true,
  });
  saveContactPhotoMock.mockResolvedValue(undefined);
  sha256HexMock.mockResolvedValue("sha-incoming");
  buildKnownLogoShaSetMock.mockResolvedValue(new Set<string>());
  reconcileAutoParentsMock.mockResolvedValue(undefined);
  syncCompanyRuleMembershipsMock.mockResolvedValue(undefined);
});

describe("pullFromGoogle pagination and sync tokens", () => {
  it("follows nextPageToken across pages and returns the LAST page's nextSyncToken", async () => {
    people.listConnectionsPage.mockImplementation(
      async (_acc: string, opts: { pageToken?: string }) => {
        if (!opts.pageToken)
          return {
            connections: [person("people/p1", { emailAddresses: [{ value: "a@x.com" }] })],
            nextPageToken: "pt-2",
          };
        if (opts.pageToken === "pt-2")
          return {
            connections: [person("people/p2", { emailAddresses: [{ value: "b@x.com" }] })],
            nextPageToken: "pt-3",
          };
        return {
          connections: [person("people/p3", { emailAddresses: [{ value: "c@x.com" }] })],
          nextSyncToken: "tok-final",
        };
      },
    );

    const res = await pullFromGoogle(IDS);

    expect(people.listConnectionsPage).toHaveBeenCalledTimes(3);
    // No stored token → a full listing with requestSyncToken on every page.
    expect(people.listConnectionsPage).toHaveBeenNthCalledWith(1, ACC, {
      pageToken: undefined,
      syncToken: undefined,
      requestSyncToken: true,
    });
    expect(people.listConnectionsPage).toHaveBeenNthCalledWith(2, ACC, {
      pageToken: "pt-2",
      syncToken: undefined,
      requestSyncToken: true,
    });
    expect(res.pulled).toBe(3);
    expect(res.peopleSyncToken).toBe("tok-final");
    expect(res.groupsSyncToken).toBe("gtok-1");
    expect(res.usedFullResync).toBe(true);
    expect(res.breakdown.created).toBe(3);
  });

  it("passes the stored tokens through for an incremental pull", async () => {
    loadSyncStateMock.mockResolvedValue(
      stateRow({ people_sync_token: "ptok-old", groups_sync_token: "gtok-old" }),
    );

    const res = await pullFromGoogle(IDS);

    expect(people.listConnectionsPage).toHaveBeenCalledWith(ACC, {
      pageToken: undefined,
      syncToken: "ptok-old",
      requestSyncToken: true,
    });
    expect(people.listContactGroupsPage).toHaveBeenCalledWith(ACC, {
      pageToken: undefined,
      syncToken: "gtok-old",
    });
    expect(res.usedFullResync).toBe(false);
  });

  it("an EXPIRED_SYNC_TOKEN mid-pagination restarts a full pull and discards partial pages", async () => {
    loadSyncStateMock.mockResolvedValue(stateRow({ people_sync_token: "ptok-stale" }));
    people.listConnectionsPage.mockImplementation(
      async (_acc: string, opts: { pageToken?: string; syncToken?: string }) => {
        if (opts.syncToken) {
          if (!opts.pageToken)
            return {
              connections: [person("people/partial", { emailAddresses: [{ value: "a@x.com" }] })],
              nextPageToken: "pt-2",
            };
          throw new PeopleApiError("People API 400: EXPIRED_SYNC_TOKEN", 400, "EXPIRED_SYNC_TOKEN");
        }
        return {
          connections: [person("people/full", { emailAddresses: [{ value: "b@x.com" }] })],
          nextSyncToken: "tok-fresh",
        };
      },
    );

    const res = await pullFromGoogle(IDS);

    // Only the person from the token-less restart is applied — the partial
    // page collected under the expired token must be thrown away, or it would
    // be double-applied by the restart.
    const inserts = writesTo("inserts", "contacts");
    expect(inserts).toHaveLength(1);
    expect((inserts[0]!.payload as { email: string }).email).toBe("b@x.com");
    expect(res.usedFullResync).toBe(true);
    expect(res.peopleSyncToken).toBe("tok-fresh");
    expect(res.pulled).toBe(1);
  });

  it("throws when the google_sync_state row is missing", async () => {
    loadSyncStateMock.mockResolvedValue(null);
    await expect(pullFromGoogle(IDS)).rejects.toThrow("google_sync_state row missing");
  });
});

describe("pullFromGoogle deleted persons", () => {
  it("unlinks a deleted person but never deletes the local contact row", async () => {
    seedContact(CT1);
    fake.seed("google_contact_links", [contactLink(CT1)]);
    people.listConnectionsPage.mockResolvedValue({
      connections: [
        person(`people/${CT1.slice(0, 8)}`, {
          metadata: { deleted: true },
          // A tombstone can still carry stale fields — the deleted flag wins.
          names: [{ displayName: "Ghost" }],
        }),
      ],
      nextSyncToken: "ptok-1",
    });

    const res = await pullFromGoogle(IDS);

    const linkDeletes = writesTo("deletes", "google_contact_links");
    expect(linkDeletes).toHaveLength(1);
    expect(linkDeletes[0]!.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "gmail_account_id", value: ACC },
        { op: "eq", col: "resource_name", value: `people/${CT1.slice(0, 8)}` },
      ]),
    );
    // The contact survives locally (unlink-only policy) and its fields are
    // not touched by the tombstone's leftover name.
    expect(writesTo("deletes", "contacts")).toHaveLength(0);
    expect(writesTo("updates", "contacts")).toHaveLength(0);
    expect(res.pulled).toBe(1);
  });
});

describe("pullFromGoogle group pull", () => {
  it("resolves a new Google label through the shared label resolver and skips system groups", async () => {
    people.listContactGroupsPage.mockResolvedValue({
      contactGroups: [
        {
          resourceName: "contactGroups/g1",
          etag: "ge-1",
          name: "Nissan, Inc.",
          groupType: "USER_CONTACT_GROUP",
        },
        {
          resourceName: "contactGroups/myContacts",
          etag: "ge-sys",
          formattedName: "myContacts",
          groupType: "SYSTEM_CONTACT_GROUP",
        },
      ],
      nextSyncToken: "gtok-2",
    });

    const res = await pullFromGoogle(IDS);

    // Only the user group goes through the resolver (folding "Nissan, Inc."
    // into an existing "Nissan" instead of spawning a local duplicate).
    expect(resolveOrCreateCompanyLabelMock).toHaveBeenCalledTimes(1);
    expect(resolveOrCreateCompanyLabelMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
      expect.objectContaining({ rawName: "Nissan, Inc." }),
    );
    const inserts = writesTo("inserts", "google_group_links");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload).toMatchObject({
      user_id: USER,
      gmail_account_id: ACC,
      contact_group_id: G_LOCAL,
      resource_name: "contactGroups/g1",
      etag: "ge-1",
    });
    expect(res.groupsSyncToken).toBe("gtok-2");
  });

  it("refreshes only the etag for an already-linked group and unlinks tombstones", async () => {
    fake.seed("google_group_links", [
      {
        gmail_account_id: ACC,
        contact_group_id: GA,
        resource_name: "contactGroups/g1",
        etag: "ge-old",
      },
      {
        gmail_account_id: ACC,
        contact_group_id: GB,
        resource_name: "contactGroups/gone",
        etag: "ge-x",
      },
    ]);
    people.listContactGroupsPage.mockResolvedValue({
      contactGroups: [
        // Google renamed the label — Atzro stays the source of truth for names.
        {
          resourceName: "contactGroups/g1",
          etag: "ge-new",
          name: "Renamed On Google",
          groupType: "USER_CONTACT_GROUP",
        },
        // No name/formattedName → treated as a deletion tombstone.
        { resourceName: "contactGroups/gone", etag: "ge-y" },
      ],
      nextSyncToken: "gtok-2",
    });

    await pullFromGoogle(IDS);

    const updates = writesTo("updates", "google_group_links");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toEqual({ etag: "ge-new" });
    // The local group's NAME is never overwritten by a pull...
    expect(writesTo("updates", "contact_groups")).toHaveLength(0);
    expect(resolveOrCreateCompanyLabelMock).not.toHaveBeenCalled();
    // ...and the tombstoned link is removed (unlink, no local group cascade).
    const deletes = writesTo("deletes", "google_group_links");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.filters).toEqual(
      expect.arrayContaining([{ op: "eq", col: "resource_name", value: "contactGroups/gone" }]),
    );
    expect(writesTo("deletes", "contact_groups")).toHaveLength(0);
  });
});

describe("pullFromGoogle create / merge for unlinked persons", () => {
  it("merges by email WITHOUT overwriting the existing contact's plaintext fields", async () => {
    seedContact(CT1, { email: "pat@example.com", name: "Pat Local", company: "Local Co" });
    people.listConnectionsPage.mockResolvedValue({
      connections: [
        person("people/new1", {
          emailAddresses: [{ value: "Pat@Example.com", type: "WORK" }],
          names: [{ displayName: "Pat Google" }],
          phoneNumbers: [{ value: "+15551234", type: "MOBILE" }],
        }),
      ],
      nextSyncToken: "ptok-1",
    });

    const res = await pullFromGoogle(IDS);

    expect(res.breakdown.merged_duplicate_email).toBe(1);
    expect(res.breakdown.created).toBe(0);
    // Merge policy: no insert, and — crucially — NO update of the contact's
    // plaintext columns: the local name/company win on first merge.
    expect(writesTo("inserts", "contacts")).toHaveLength(0);
    expect(writesTo("updates", "contacts")).toHaveLength(0);

    // The link is recorded against the merged-into contact.
    const linkUpserts = writesTo("upserts", "google_contact_links");
    expect(linkUpserts[0]!.payload).toMatchObject({
      user_id: USER,
      gmail_account_id: ACC,
      contact_id: CT1,
      resource_name: "people/new1",
      etag: "etag-people/new1",
    });
    expect(linkUpserts[0]!.options).toEqual({ onConflict: "gmail_account_id,contact_id" });

    // Sub-rows and encrypted fields ARE applied from Google, though: phones
    // are replaced wholesale, emails land lowercased with positions.
    expect(writesTo("deletes", "contact_phones")).toHaveLength(1);
    expect(writesTo("inserts", "contact_phones")[0]!.payload).toEqual([
      {
        user_id: USER,
        contact_id: CT1,
        label: "mobile",
        number: "+15551234",
        is_primary: true,
        position: 0,
      },
    ]);
    expect(writesTo("inserts", "contact_emails")[0]!.payload).toEqual([
      {
        user_id: USER,
        contact_id: CT1,
        label: "work",
        address: "pat@example.com",
        is_primary: true,
        position: 0,
      },
    ]);
    // Fields Google did not send are undefined ("leave alone"); null would
    // now mean "clear", which would wipe locally-held notes and address.
    expect(setContactEncryptedFieldsMock).toHaveBeenCalledWith({
      contact_id: CT1,
      notes: undefined,
      address_line1: undefined,
      address_line2: undefined,
      phone: "+15551234",
    });
    // The stamp comes from the contact row's actual updated_at, not now().
    expect(finalLinkUpserts()[0]!.payload).toMatchObject({ last_synced_at: OLD });
  });

  it("falls back to the emailless dedup for a person with no email", async () => {
    seedContact(CT2, { email: null });
    findEmaillessDuplicateMock.mockResolvedValue(CT2);
    people.listConnectionsPage.mockResolvedValue({
      connections: [
        person("people/new2", {
          names: [{ displayName: "Sam Phone" }],
          phoneNumbers: [{ value: "+15559999", type: "mobile" }],
        }),
      ],
      nextSyncToken: "ptok-1",
    });

    const res = await pullFromGoogle(IDS);

    expect(findEmaillessDuplicateMock).toHaveBeenCalledWith({
      userId: USER,
      name: "Sam Phone",
      company: null,
      // The duplication is real SUT behavior, not a typo: pull.server.ts
      // concatenates parsed.phones with patch.primary_phone. Harmless for
      // dedup matching; if the SUT ever dedupes this array, update here.
      phones: ["+15559999", "+15559999"],
    });
    expect(res.breakdown.merged_by_phone).toBe(1);
    expect(writesTo("inserts", "contacts")).toHaveLength(0);
  });

  it("creates a new contact with source=google, lowercased email and a resolved company_id", async () => {
    resolveContactCompanyMock.mockResolvedValue({ companyId: "comp-1", canonicalName: "Acme" });
    people.listConnectionsPage.mockResolvedValue({
      connections: [
        person("people/new3", {
          emailAddresses: [{ value: "New@Person.com" }],
          names: [{ givenName: "Nina", familyName: "New" }],
          organizations: [{ name: "Acme", title: "CTO" }],
        }),
      ],
      nextSyncToken: "ptok-1",
    });

    const res = await pullFromGoogle(IDS);

    const inserts = writesTo("inserts", "contacts");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload).toMatchObject({
      user_id: USER,
      email: "new@person.com",
      source: "google",
      name: "Nina New",
      company: "Acme",
      company_id: "comp-1",
      title: "CTO",
    });
    expect(resolveContactCompanyMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
      "Acme",
      expect.any(Map),
    );
    expect(res.breakdown.created).toBe(1);
  });

  it("skips a person with no identity at all and counts it as skipped_no_email", async () => {
    people.listConnectionsPage.mockResolvedValue({
      connections: [person("people/empty", { photos: [{ url: "https://ph/x" }] })],
      nextSyncToken: "ptok-1",
    });

    const res = await pullFromGoogle(IDS);

    expect(res.breakdown.skipped_no_email).toBe(1);
    expect(writesTo("inserts", "contacts")).toHaveLength(0);
    expect(writesTo("upserts", "google_contact_links")).toHaveLength(0);
  });

  it("one failed contact insert does not abort the rest of the batch", async () => {
    fake.onInsert("contacts", (payload) =>
      (payload as { email: string }).email === "a@example.com"
        ? { message: "insert exploded" }
        : null,
    );
    people.listConnectionsPage.mockResolvedValue({
      connections: [
        person("people/bad", { emailAddresses: [{ value: "a@example.com" }] }),
        person("people/good", { emailAddresses: [{ value: "b@example.com" }] }),
      ],
      nextSyncToken: "ptok-1",
    });

    const res = await pullFromGoogle(IDS);

    expect(res.breakdown.failed).toBe(1);
    expect(res.breakdown.created).toBe(1);
    expect(writesTo("inserts", "contacts")).toHaveLength(2); // attempted both
    expect(logErrorMock).toHaveBeenCalledWith(
      "google_contacts.pull.contact_create_failed",
      expect.objectContaining({ email: "a@example.com", resource: "people/bad" }),
      expect.anything(),
    );
  });
});

describe("pullFromGoogle merge policy for linked contacts", () => {
  it("hard-overwrites every plaintext field on a clean linked contact — missing Google fields become null", async () => {
    seedContact(CT1, { website: "https://old.example", city: "Boston" });
    fake.seed("google_contact_links", [contactLink(CT1)]);
    resolveContactCompanyMock.mockResolvedValue({ companyId: "comp-1", canonicalName: "Acme" });
    people.listConnectionsPage.mockResolvedValue({
      connections: [
        person(`people/${CT1.slice(0, 8)}`, {
          emailAddresses: [{ value: "Gio@Acme.com", metadata: { primary: true } }],
          names: [{ displayName: "Gio Google" }],
          organizations: [{ name: "Acme", title: "CTO" }],
          urls: [{ value: "https://acme.example", type: "homepage" }],
        }),
      ],
      nextSyncToken: "ptok-1",
    });

    const res = await pullFromGoogle(IDS);

    const updates = writesTo("updates", "contacts");
    expect(updates).toHaveLength(1);
    // Characterized merge policy: Google's copy wins wholesale for a clean
    // linked contact. Fields Google doesn't have (city, linkedin, ...) are
    // nulled out — a local-only city set on iPhone/web is LOST here unless
    // the edit bumped updated_at past last_synced_at (dirty gate).
    expect(updates[0]!.payload).toEqual({
      name: "Gio Google",
      company: "Acme",
      company_id: "comp-1",
      title: "CTO",
      website: "https://acme.example",
      linkedin: null,
      twitter: null,
      city: null,
      region: null,
      postal_code: null,
      country: null,
      email: "gio@acme.com",
    });
    expect(res.breakdown.updated).toBe(1);
    // Rule/subgroup reconcilers see the touched contact afterwards.
    expect(reconcileAutoParentsMock).toHaveBeenCalledWith(expect.anything(), USER, [CT1]);
    expect(syncCompanyRuleMembershipsMock).toHaveBeenCalledWith(expect.anything(), USER, {
      contactIds: [CT1],
    });
  });

  it("preserves local emails AND phones when the Google person carries neither", async () => {
    seedContact(CT1);
    fake.seed("google_contact_links", [contactLink(CT1)]);
    fake.seed("contact_emails", [{ contact_id: CT1, address: "pat@example.com" }]);
    people.listConnectionsPage.mockResolvedValue({
      connections: [person(`people/${CT1.slice(0, 8)}`, { names: [{ displayName: "Pat" }] })],
      nextSyncToken: "ptok-1",
    });

    await pullFromGoogle(IDS);

    // `email` is only written when Google has one: the column is absent from
    // the update payload and the contact_emails rows are left alone.
    const updates = writesTo("updates", "contacts");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).not.toHaveProperty("email");
    expect(writesTo("deletes", "contact_emails")).toHaveLength(0);
    expect(writesTo("inserts", "contact_emails")).toHaveLength(0);
    // Same for phones: an unconditional delete used to destroy numbers held
    // locally (or synced from an iPhone) whenever Google had none.
    expect(writesTo("deletes", "contact_phones")).toHaveLength(0);
    expect(writesTo("inserts", "contact_phones")).toHaveLength(0);
  });

  it("dirty gating: a locally-edited contact is left untouched — only the remote etag is refreshed", async () => {
    // Local edit (NEWER) after the last sync (OLD) → the pending push wins.
    seedContact(CT1, { updated_at: NEWER, name: "Edited Locally" });
    fake.seed("google_contact_links", [contactLink(CT1, { last_synced_at: OLD })]);
    people.listConnectionsPage.mockResolvedValue({
      connections: [
        person(`people/${CT1.slice(0, 8)}`, {
          names: [{ displayName: "Stale Google Copy" }],
          emailAddresses: [{ value: "stale@x.com" }],
        }),
      ],
      nextSyncToken: "ptok-1",
    });

    const res = await pullFromGoogle(IDS);

    expect(writesTo("updates", "contacts")).toHaveLength(0);
    expect(writesTo("deletes", "contact_phones")).toHaveLength(0);
    expect(setContactEncryptedFieldsMock).not.toHaveBeenCalled();
    expect(finalLinkUpserts()).toHaveLength(0); // last_synced_at NOT advanced
    // Only the etag moves, so the next push can still do an etag-safe update.
    const linkUpdates = writesTo("updates", "google_contact_links");
    expect(linkUpdates).toHaveLength(1);
    expect(linkUpdates[0]!.payload).toEqual({ etag: `etag-people/${CT1.slice(0, 8)}` });
    expect(res.breakdown.updated).toBe(0);
  });
});

describe("pullFromGoogle membership diff", () => {
  it("adds/removes only Google-mirrored groups, preserving Atzro-only and auto-generated memberships", async () => {
    seedContact(CT1);
    fake.seed("google_contact_links", [contactLink(CT1)]);
    fake.seed("google_group_links", [
      { gmail_account_id: ACC, contact_group_id: GA, resource_name: "contactGroups/a", etag: "e" },
      { gmail_account_id: ACC, contact_group_id: GB, resource_name: "contactGroups/b", etag: "e" },
      {
        gmail_account_id: ACC,
        contact_group_id: GC_AUTO,
        resource_name: "contactGroups/c",
        etag: "e",
      },
    ]);
    // GC_AUTO is an auto-company subgroup — fully owned by the reconciler.
    fake.seed("contact_groups", [
      { id: GC_AUTO, user_id: USER, auto_generated_from_group_id: "parent-1" },
    ]);
    // Currently a member of GB (google-linked) and G_LOCAL (Atzro-only).
    fake.seed("contact_group_members", [
      { contact_id: CT1, group_id: GB },
      { contact_id: CT1, group_id: G_LOCAL },
    ]);
    people.listConnectionsPage.mockResolvedValue({
      connections: [
        person(`people/${CT1.slice(0, 8)}`, {
          names: [{ displayName: "Pat" }],
          memberships: [
            { contactGroupMembership: { contactGroupResourceName: "contactGroups/a" } },
            { contactGroupMembership: { contactGroupResourceName: "contactGroups/c" } },
            { contactGroupMembership: { contactGroupResourceName: "contactGroups/unknown" } },
          ],
        }),
      ],
      nextSyncToken: "ptok-1",
    });

    await pullFromGoogle(IDS);

    // Added: GA (desired, absent). NOT added: GC_AUTO (reconciler-owned) or
    // the unlinked resource. Removed: GB (google-linked, no longer desired).
    // NOT removed: G_LOCAL (Atzro-only membership Google knows nothing about).
    const adds = writesTo("inserts", "contact_group_members");
    expect(adds).toHaveLength(1);
    expect(adds[0]!.payload).toEqual([{ user_id: USER, contact_id: CT1, group_id: GA }]);
    const removes = writesTo("deletes", "contact_group_members");
    expect(removes).toHaveLength(1);
    expect(removes[0]!.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "contact_id", value: CT1 },
        { op: "in", col: "group_id", value: [GB] },
      ]),
    );
  });
});

describe("pullFromGoogle photo handling", () => {
  const RESOURCE = `people/${CT1.slice(0, 8)}`;

  function seedLinkedWithPhoto(over: {
    avatarSource?: string | null;
    linkPhotoUrl?: string | null;
    googlePhotoUrl?: string;
  }): void {
    seedContact(CT1, { avatar_source: over.avatarSource ?? null });
    fake.seed("google_contact_links", [
      contactLink(CT1, { google_photo_url: over.linkPhotoUrl ?? null }),
    ]);
    people.listConnectionsPage.mockResolvedValue({
      connections: [
        person(RESOURCE, {
          names: [{ displayName: "Pat" }],
          photos: [{ url: over.googlePhotoUrl ?? "https://ph/new", metadata: { primary: true } }],
        }),
      ],
      nextSyncToken: "ptok-1",
    });
  }

  it("fetches and saves the photo when Google's URL changed, then records the URL on the link", async () => {
    seedLinkedWithPhoto({});

    await pullFromGoogle(IDS);

    expect(people.fetchPhotoBytes).toHaveBeenCalledWith("https://ph/new");
    expect(saveContactPhotoMock).toHaveBeenCalledWith(
      USER,
      CT1,
      new Uint8Array([1, 2, 3]),
      "image/png",
      "google",
    );
    expect(finalLinkUpserts()[0]!.payload).toMatchObject({ google_photo_url: "https://ph/new" });
  });

  it("never replaces a user-chosen photo, but still records the URL so it doesn't retry forever", async () => {
    seedLinkedWithPhoto({ avatarSource: "user_upload" });

    await pullFromGoogle(IDS);

    expect(people.fetchPhotoBytes).not.toHaveBeenCalled();
    expect(saveContactPhotoMock).not.toHaveBeenCalled();
    expect(finalLinkUpserts()[0]!.payload).toMatchObject({ google_photo_url: "https://ph/new" });
  });

  it("makes no photo fetch at all when the Google URL is unchanged since the last pull", async () => {
    seedLinkedWithPhoto({ linkPhotoUrl: "https://ph/same", googlePhotoUrl: "https://ph/same" });

    await pullFromGoogle(IDS);

    expect(people.fetchPhotoBytes).not.toHaveBeenCalled();
    expect(saveContactPhotoMock).not.toHaveBeenCalled();
    // No change → the stamping upsert leaves google_photo_url alone.
    expect(finalLinkUpserts()[0]!.payload).not.toHaveProperty("google_photo_url");
  });

  it("skips saving bytes that hash to a known company logo (still records the URL)", async () => {
    seedLinkedWithPhoto({});
    buildKnownLogoShaSetMock.mockResolvedValue(new Set(["sha-incoming"]));

    await pullFromGoogle(IDS);

    expect(people.fetchPhotoBytes).toHaveBeenCalledTimes(1); // had to hash them
    expect(saveContactPhotoMock).not.toHaveBeenCalled();
    expect(finalLinkUpserts()[0]!.payload).toMatchObject({ google_photo_url: "https://ph/new" });
  });
});

describe("forceFullResync", () => {
  it("clears both sync tokens so the next tick performs a full pull", async () => {
    await forceFullResync(USER, ACC);

    expect(ensureSyncStateMock).toHaveBeenCalledWith(USER, ACC);
    expect(updateSyncStateMock).toHaveBeenCalledWith("state-1", {
      people_sync_token: null,
      groups_sync_token: null,
      last_error: null,
    });
  });
});
