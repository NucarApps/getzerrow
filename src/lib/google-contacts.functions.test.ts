// Unit tests for the Google Contacts settings server fns
// (src/lib/google-contacts.functions.ts). Contracts pinned here:
//
//   - every one of the eight fns refuses an accountId (or contactId) that
//     belongs to another user, before any write;
//   - a manual run is an implicit opt-in: a disabled account is switched on,
//     and only a mode of "off" is upgraded to "pull_only" — an account that
//     was already "two_way" keeps that mode;
//   - setGoogleContactsSyncMode derives `enabled` from the mode ("off" is
//     the only mode that disables), and the interval setter writes only the
//     interval;
//   - getGoogleContactsSyncStatus's backlog counters, which are the numbers
//     the settings page shows: what is unlinked, body-dirty, photo-dirty and
//     mirrored as a group membership;
//   - backfillGoogleContactPhotos clears photo_etag for exactly the stale
//     links (bulk `in(contact_id, …)`), kicks a sync, and short-circuits to
//     `cleared: 0` with no write when nothing is stale.
//
// The state module runs for real against the fake so the google_sync_state
// payloads are the real ones; only the heavy sync entry points are stubbed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";

const fake = makeSupabaseFake({ applyWrites: true });

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const runGoogleContactsSync =
  vi.fn<(userId: string, accountId: string) => Promise<{ ok: boolean }>>();
const getGoogleContactsStatus =
  vi.fn<(userId: string, accountId: string) => Promise<{ needs_reconnect: boolean }>>();
vi.mock("@/lib/google-contacts/reconcile.server", () => ({
  runGoogleContactsSync: (userId: string, accountId: string) =>
    runGoogleContactsSync(userId, accountId),
  getGoogleContactsStatus: (userId: string, accountId: string) =>
    getGoogleContactsStatus(userId, accountId),
}));

const forceFullResync = vi.fn<(userId: string, accountId: string) => Promise<void>>();
vi.mock("@/lib/google-contacts/pull.server", () => ({
  forceFullResync: (userId: string, accountId: string) => forceFullResync(userId, accountId),
}));

const repullContact = vi.fn<(userId: string, contactId: string) => Promise<{ ok: boolean }>>();
const backfillMultiEmails =
  vi.fn<(userId: string, accountId: string) => Promise<{ contactsScanned: number }>>();
vi.mock("@/lib/google-contacts/repair.server", () => ({
  repullContact: (userId: string, contactId: string) => repullContact(userId, contactId),
  backfillMultiEmails: (userId: string, accountId: string) =>
    backfillMultiEmails(userId, accountId),
}));

import {
  syncGoogleContactsNow,
  forceFullGoogleContactsResync,
  getGoogleContactsSyncStatus,
  setGoogleContactsSyncMode,
  setGoogleContactsSyncInterval,
  repullContactFromGoogle,
  backfillMultiEmailsFromGoogle,
  backfillGoogleContactPhotos,
} from "./google-contacts.functions";

const ACC = "11111111-1111-4111-8111-111111111111";
const OTHER_ACC = "22222222-2222-4222-8222-222222222222";
const STATE = "33333333-3333-4333-8333-333333333333";
const CONTACT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONTACT_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GROUP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ATTACKER = "attacker-user";

function seedAccounts() {
  fake.seed("gmail_accounts", [
    { id: ACC, user_id: TEST_USER, email_address: "me@example.com" },
    { id: OTHER_ACC, user_id: "victim-user", email_address: "victim@example.com" },
  ]);
}

/** A google_sync_state row with every column the SUT reads. */
function seedState(patch: { enabled: boolean; sync_mode: "off" | "pull_only" | "two_way" }) {
  fake.seed("google_sync_state", [
    {
      id: STATE,
      user_id: TEST_USER,
      gmail_account_id: ACC,
      enabled: patch.enabled,
      sync_mode: patch.sync_mode,
      sync_interval_minutes: 15,
    },
  ]);
}

beforeEach(() => {
  fake.reset();
  seedAccounts();
  fake.onEmbed("google_contact_links", "contacts", { table: "contacts" });
  runGoogleContactsSync.mockResolvedValue({ ok: true });
  getGoogleContactsStatus.mockResolvedValue({ needs_reconnect: false });
  forceFullResync.mockResolvedValue();
  repullContact.mockResolvedValue({ ok: true });
  backfillMultiEmails.mockResolvedValue({ contactsScanned: 3 });
});

describe("assertOwnsAccount (shared guard on every account-scoped fn)", () => {
  const accountFns = [
    ["syncGoogleContactsNow", syncGoogleContactsNow],
    ["forceFullGoogleContactsResync", forceFullGoogleContactsResync],
    ["getGoogleContactsSyncStatus", getGoogleContactsSyncStatus],
    ["setGoogleContactsSyncInterval", setGoogleContactsSyncInterval],
    ["backfillMultiEmailsFromGoogle", backfillMultiEmailsFromGoogle],
    ["backfillGoogleContactPhotos", backfillGoogleContactPhotos],
  ] as const;

  it.each(accountFns)("%s refuses an account owned by another user", async (_name, fn) => {
    seedState({ enabled: false, sync_mode: "off" });
    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(fn, ATTACKER)({ data: { accountId: OTHER_ACC, intervalMinutes: 5 } }),
      rejects: "Account not found",
    });
    expect(runGoogleContactsSync).not.toHaveBeenCalled();
    expect(forceFullResync).not.toHaveBeenCalled();
    expect(backfillMultiEmails).not.toHaveBeenCalled();
  });

  it("setGoogleContactsSyncMode refuses an account owned by another user", async () => {
    seedState({ enabled: true, sync_mode: "two_way" });
    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(
          setGoogleContactsSyncMode,
          ATTACKER,
        )({ data: { accountId: OTHER_ACC, mode: "off" } }),
      rejects: "Account not found",
    });
  });

  it("repullContactFromGoogle refuses a contact owned by another user", async () => {
    fake.seed("contacts", [{ id: CONTACT_A, user_id: "victim-user" }]);
    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(repullContactFromGoogle, ATTACKER)({ data: { contactId: CONTACT_A } }),
      rejects: "Contact not found",
    });
    expect(repullContact).not.toHaveBeenCalled();
  });

  it("surfaces a lookup failure rather than reporting a missing account", async () => {
    fake.onSelect("gmail_accounts", () => ({ message: "connection reset" }));
    await expect(syncGoogleContactsNow({ data: { accountId: ACC } })).rejects.toThrow(
      "Account lookup failed: connection reset",
    );
  });
});

describe("syncGoogleContactsNow", () => {
  it("opts a disabled, off account into pull_only before running the sync", async () => {
    seedState({ enabled: false, sync_mode: "off" });

    await syncGoogleContactsNow({ data: { accountId: ACC } });

    expect(fake.calls.updates).toHaveLength(1);
    expect(fake.calls.updates[0]).toMatchObject({
      table: "google_sync_state",
      payload: { enabled: true, sync_mode: "pull_only" },
      filters: [{ op: "eq", col: "id", value: STATE, extra: undefined }],
    });
    expect(runGoogleContactsSync).toHaveBeenCalledWith(TEST_USER, ACC);
  });

  it("re-enables a disabled two_way account without downgrading it to pull_only", async () => {
    seedState({ enabled: false, sync_mode: "two_way" });

    await syncGoogleContactsNow({ data: { accountId: ACC } });

    expect(fake.calls.updates[0]?.payload).toStrictEqual({
      enabled: true,
      sync_mode: "two_way",
    });
  });

  it("writes nothing when the account is already enabled", async () => {
    seedState({ enabled: true, sync_mode: "pull_only" });

    const result = await syncGoogleContactsNow({ data: { accountId: ACC } });

    expect(writeCount(fake)).toBe(0);
    expect(result).toStrictEqual({ ok: true });
  });

  it("creates the sync state row when the account has never synced", async () => {
    fake.seed("google_sync_state", []);

    await syncGoogleContactsNow({ data: { accountId: ACC } });

    expect(fake.calls.inserts).toHaveLength(1);
    expect(fake.calls.inserts[0]).toMatchObject({
      table: "google_sync_state",
      payload: { user_id: TEST_USER, gmail_account_id: ACC },
    });
  });

  it("rejects an accountId that is not a uuid before touching the database", async () => {
    await expect(syncGoogleContactsNow({ data: { accountId: "not-a-uuid" } })).rejects.toThrow();
    expect(fake.calls.selects).toHaveLength(0);
  });
});

describe("forceFullGoogleContactsResync", () => {
  it("drops the sync tokens and then runs a full sync, in that order", async () => {
    seedState({ enabled: true, sync_mode: "two_way" });
    const order: string[] = [];
    forceFullResync.mockImplementation(async () => void order.push("forceFullResync"));
    runGoogleContactsSync.mockImplementation(async () => {
      order.push("runGoogleContactsSync");
      return { ok: true };
    });

    await forceFullGoogleContactsResync({ data: { accountId: ACC } });

    expect(order).toStrictEqual(["forceFullResync", "runGoogleContactsSync"]);
    expect(forceFullResync).toHaveBeenCalledWith(TEST_USER, ACC);
  });

  it("opts an off account into pull_only, like the manual sync does", async () => {
    seedState({ enabled: false, sync_mode: "off" });

    await forceFullGoogleContactsResync({ data: { accountId: ACC } });

    expect(fake.calls.updates[0]?.payload).toStrictEqual({
      enabled: true,
      sync_mode: "pull_only",
    });
  });
});

describe("setGoogleContactsSyncMode", () => {
  it.each([
    ["off", false],
    ["pull_only", true],
    ["two_way", true],
  ] as const)("mode %s writes enabled=%s", async (mode, enabled) => {
    seedState({ enabled: true, sync_mode: "pull_only" });

    const result = await setGoogleContactsSyncMode({ data: { accountId: ACC, mode } });

    expect(result).toStrictEqual({ ok: true });
    expect(fake.calls.updates).toHaveLength(1);
    expect(fake.calls.updates[0]?.payload).toStrictEqual({ sync_mode: mode, enabled });
    expect(fake.calls.updates[0]?.filters).toStrictEqual([
      { op: "eq", col: "id", value: STATE, extra: undefined },
    ]);
  });

  it("rejects a mode outside the enum", async () => {
    seedState({ enabled: true, sync_mode: "pull_only" });
    await expect(
      setGoogleContactsSyncMode({
        data: { accountId: ACC, mode: "sideways" as unknown as "off" },
      }),
    ).rejects.toThrow();
    expect(writeCount(fake)).toBe(0);
  });
});

describe("setGoogleContactsSyncInterval", () => {
  it("writes only the interval, leaving enabled and the mode untouched", async () => {
    seedState({ enabled: false, sync_mode: "off" });

    await setGoogleContactsSyncInterval({ data: { accountId: ACC, intervalMinutes: 60 } });

    expect(fake.calls.updates).toHaveLength(1);
    expect(fake.calls.updates[0]?.payload).toStrictEqual({ sync_interval_minutes: 60 });
  });

  it("rejects an interval outside the allowed set", async () => {
    seedState({ enabled: true, sync_mode: "pull_only" });
    await expect(
      setGoogleContactsSyncInterval({
        data: { accountId: ACC, intervalMinutes: 30 as unknown as 60 },
      }),
    ).rejects.toThrow();
    expect(writeCount(fake)).toBe(0);
  });
});

describe("getGoogleContactsSyncStatus backlog", () => {
  it("counts unlinked, body-dirty, photo-dirty contacts and mirrored memberships", async () => {
    fake.seed("contacts", [
      // Linked, synced after its last edit, photo already pushed → clean.
      {
        id: CONTACT_A,
        user_id: TEST_USER,
        updated_at: "2026-01-01T00:00:00Z",
        avatar_url: "a.png",
      },
      // Linked but edited after the last sync → body-dirty.
      { id: CONTACT_B, user_id: TEST_USER, updated_at: "2026-01-03T00:00:00Z", avatar_url: null },
      // Not linked at all → unlinked, and body-pending.
      { id: CONTACT_C, user_id: TEST_USER, updated_at: "2026-01-01T00:00:00Z", avatar_url: null },
    ]);
    fake.seed("google_contact_links", [
      {
        contact_id: CONTACT_A,
        user_id: TEST_USER,
        gmail_account_id: ACC,
        last_synced_at: "2026-01-02T00:00:00Z",
        photo_etag: "a.png",
        photo_push_attempts: 0,
        resource_name: "people/a",
      },
      {
        contact_id: CONTACT_B,
        user_id: TEST_USER,
        gmail_account_id: ACC,
        last_synced_at: "2026-01-02T00:00:00Z",
        photo_etag: null,
        photo_push_attempts: 0,
        resource_name: "people/b",
      },
    ]);
    fake.seed("google_group_links", [
      { contact_group_id: GROUP, gmail_account_id: ACC, resource_name: "contactGroups/g" },
    ]);
    fake.seed("contact_group_members", [
      { contact_id: CONTACT_A, group_id: GROUP, user_id: TEST_USER },
      // Contact is not linked to Google → not a mirrored membership.
      { contact_id: CONTACT_C, group_id: GROUP, user_id: TEST_USER },
    ]);

    const status = await getGoogleContactsSyncStatus({ data: { accountId: ACC } });

    expect(status).toStrictEqual({
      needs_reconnect: false,
      backlog: {
        totalContacts: 3,
        linkedContacts: 2,
        unlinkedContacts: 1,
        // CONTACT_B (edited after sync) and CONTACT_C (no link at all).
        bodyPending: 2,
        // CONTACT_B's link has a null photo_etag, so the photo lane owes it a visit.
        photoPending: 1,
        linkedGroups: 1,
        linkedMemberships: 1,
      },
    });
  });

  it("reports an empty backlog for an account with no contacts", async () => {
    fake.seed("contacts", []);
    fake.seed("google_contact_links", []);
    fake.seed("google_group_links", []);
    fake.seed("contact_group_members", []);

    const status = await getGoogleContactsSyncStatus({ data: { accountId: ACC } });

    expect(status).toStrictEqual({
      needs_reconnect: false,
      backlog: {
        totalContacts: 0,
        linkedContacts: 0,
        unlinkedContacts: 0,
        bodyPending: 0,
        photoPending: 0,
        linkedGroups: 0,
        linkedMemberships: 0,
      },
    });
  });
});

describe("repull / backfill passthroughs", () => {
  it("repullContactFromGoogle forwards the caller's own id to the repair module", async () => {
    fake.seed("contacts", [{ id: CONTACT_A, user_id: TEST_USER }]);
    repullContact.mockResolvedValue({ ok: false });

    const result = await repullContactFromGoogle({ data: { contactId: CONTACT_A } });

    expect(repullContact).toHaveBeenCalledWith(TEST_USER, CONTACT_A);
    expect(result).toStrictEqual({ ok: false });
  });

  it("backfillMultiEmailsFromGoogle forwards the account and returns the summary", async () => {
    const result = await backfillMultiEmailsFromGoogle({ data: { accountId: ACC } });

    expect(backfillMultiEmails).toHaveBeenCalledWith(TEST_USER, ACC);
    expect(result).toStrictEqual({ contactsScanned: 3 });
  });
});

describe("backfillGoogleContactPhotos", () => {
  /** Links that qualify: a cached photo_etag AND no local avatar. */
  function seedStaleLinks() {
    fake.seed("contacts", [
      { id: CONTACT_A, user_id: TEST_USER, avatar_url: null },
      { id: CONTACT_B, user_id: TEST_USER, avatar_url: null },
      { id: CONTACT_C, user_id: TEST_USER, avatar_url: null },
    ]);
    fake.seed("google_contact_links", [
      { contact_id: CONTACT_A, user_id: TEST_USER, gmail_account_id: ACC, photo_etag: "etag-a" },
      { contact_id: CONTACT_B, user_id: TEST_USER, gmail_account_id: ACC, photo_etag: "etag-b" },
      // Already cleared → excluded by `.not("photo_etag", "is", null)`.
      { contact_id: CONTACT_C, user_id: TEST_USER, gmail_account_id: ACC, photo_etag: null },
      // Another account's link → excluded by the gmail_account_id filter.
      {
        contact_id: CONTACT_C,
        user_id: TEST_USER,
        gmail_account_id: OTHER_ACC,
        photo_etag: "etag-other",
      },
    ]);
  }

  it("scopes the stale-link query to the caller, the account and a missing avatar", async () => {
    seedStaleLinks();

    await backfillGoogleContactPhotos({ data: { accountId: ACC } });

    const read = fake.calls.selects.find((s) => s.table === "google_contact_links");
    expect(read?.columns).toBe("contact_id, contacts!inner(avatar_url)");
    expect(read?.filters).toStrictEqual([
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
      { op: "eq", col: "gmail_account_id", value: ACC, extra: undefined },
      { op: "not", col: "photo_etag", value: null, extra: "is" },
      { op: "is", col: "contacts.avatar_url", value: null, extra: undefined },
    ]);
  });

  it("clears photo_etag for exactly the stale links and kicks a sync", async () => {
    seedStaleLinks();

    const result = await backfillGoogleContactPhotos({ data: { accountId: ACC } });

    expect(result).toStrictEqual({ ok: true, cleared: 2, synced: true });
    expect(fake.calls.updates).toHaveLength(1);
    expect(fake.calls.updates[0]).toStrictEqual({
      table: "google_contact_links",
      payload: { photo_etag: null },
      options: undefined,
      filters: [
        { op: "eq", col: "gmail_account_id", value: ACC, extra: undefined },
        { op: "in", col: "contact_id", value: [CONTACT_A, CONTACT_B], extra: undefined },
      ],
    });
    expect(runGoogleContactsSync).toHaveBeenCalledWith(TEST_USER, ACC);
    // The other account's link keeps its etag.
    expect(
      fake.rows("google_contact_links").find((r) => r.gmail_account_id === OTHER_ACC)?.photo_etag,
    ).toBe("etag-other");
  });

  it("returns cleared: 0 with no write and no sync when nothing is stale", async () => {
    fake.seed("contacts", [{ id: CONTACT_A, user_id: TEST_USER, avatar_url: null }]);
    fake.seed("google_contact_links", [
      { contact_id: CONTACT_A, user_id: TEST_USER, gmail_account_id: ACC, photo_etag: null },
    ]);

    const result = await backfillGoogleContactPhotos({ data: { accountId: ACC } });

    expect(result).toStrictEqual({ ok: true, cleared: 0, synced: false });
    expect(writeCount(fake)).toBe(0);
    expect(runGoogleContactsSync).not.toHaveBeenCalled();
  });

  it("still reports the clear when the follow-up sync kick fails", async () => {
    seedStaleLinks();
    runGoogleContactsSync.mockRejectedValue(new Error("People API 503"));

    const result = await backfillGoogleContactPhotos({ data: { accountId: ACC } });

    expect(result).toStrictEqual({ ok: true, cleared: 2, synced: true });
  });

  it("surfaces a failed stale-link read instead of reporting nothing to do", async () => {
    fake.onSelect("google_contact_links", () => ({ message: "statement timeout" }));

    await expect(backfillGoogleContactPhotos({ data: { accountId: ACC } })).rejects.toThrow(
      "statement timeout",
    );
    expect(writeCount(fake)).toBe(0);
  });
});
