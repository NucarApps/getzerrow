// Tests for mergeContactsManual (src/lib/contacts/dedup.functions.ts), the
// user-driven merge with a per-field primary picker.
//
// It is the most destructive path in the contacts area: ten steps that move
// every reference off the losers and then delete them. The fake is mounted
// with `applyWrites: true` so the survivor's POST-merge state is observable
// rather than inferred from a list of recorded calls — a test that only
// asserts "an update was issued" cannot tell a transfer from a wipe.
//
// The invariant the suite is built around: the losers are deleted LAST. Any
// transfer that fails must abort while the loser rows are still there, so
// the user can retry instead of losing the data that failed to move.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

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
vi.mock("@/lib/log.server", () => ({ logInfo: vi.fn(), logError: vi.fn() }));

const deps = vi.hoisted(() => ({
  reconcileAutoParentsForContacts:
    vi.fn<typeof import("./auto-company-subgroups.functions").reconcileAutoParentsForContacts>(),
  getContactDecrypted: vi.fn<typeof import("@/lib/sync/encrypted-reader").getContactDecrypted>(),
  setContactEncryptedFields:
    vi.fn<typeof import("@/lib/sync/encrypted-writer").setContactEncryptedFields>(),
}));

vi.mock("./auto-company-subgroups.functions", () => ({
  reconcileAutoParentsForContacts: deps.reconcileAutoParentsForContacts,
}));
vi.mock("@/lib/sync/encrypted-reader", () => ({
  getContactDecrypted: deps.getContactDecrypted,
}));
vi.mock("@/lib/sync/encrypted-writer", () => ({
  setContactEncryptedFields: deps.setContactEncryptedFields,
}));

import { mergeContactsManual } from "./dedup.functions";

const USER = "test-user-1"; // matches server-fn-stub TEST_USER
const SURVIVOR = "aaaaaaaa-1111-4111-8111-111111111111";
const LOSER = "bbbbbbbb-2222-4222-8222-222222222222";
const LOSER_2 = "cccccccc-3333-4333-8333-333333333333";
const GROUP_KEEP = "dddddddd-4444-4444-8444-444444444444";
const GROUP_MOVE = "eeeeeeee-5555-4555-8555-555555555555";
const GROUP_DROP = "ffffffff-6666-4666-8666-666666666666";

const ctx = { context: { supabase: fake.supabaseAdmin } };

type MergeInput = {
  primaryId: string;
  loserIds: string[];
  fields: Record<string, string | null>;
  notesSource: string | null;
  emails: Array<{ label: string; address: string; is_primary: boolean }>;
  phones: Array<{ label: string; number: string; is_primary: boolean }>;
  excludedGroupIds: string[];
  manualLockFields: string[];
};

function input(overrides: Partial<MergeInput> = {}): MergeInput {
  return {
    primaryId: SURVIVOR,
    loserIds: [LOSER],
    fields: {},
    notesSource: null,
    emails: [],
    phones: [],
    excludedGroupIds: [],
    manualLockFields: [],
    ...overrides,
  };
}

/** A decrypted contact as the id-keyed RPC returns it. */
function decryptedContact(
  overrides: Partial<import("@/lib/sync/encrypted-reader").DecryptedContact> & { id: string },
): import("@/lib/sync/encrypted-reader").DecryptedContact {
  return {
    user_id: USER,
    email: null,
    name: null,
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
    source: "manual",
    enriched_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Survivor + losers, all owned by the signed-in user. */
function seedContacts(ids: string[] = [SURVIVOR, LOSER]) {
  fake.seed(
    "contacts",
    ids.map((id) => ({
      id,
      user_id: USER,
      name: id === SURVIVOR ? "Jane Roe" : "J. Roe",
      email: null,
      company: null,
      company_id: null,
      manual_overrides: [],
    })),
  );
}

/** Ordered log of every write the merge issues, so "the losers are deleted
 * last" can be asserted as a position rather than a guess. */
function trackWriteOrder(): string[] {
  const log: string[] = [];
  const tables = [
    "contacts",
    "contact_emails",
    "contact_phones",
    "contact_group_members",
    "contact_revisions",
    "contact_cards_sent",
    "google_contact_links",
    "carddav_tombstones",
    "google_contact_tombstones",
    "carddav_settings",
    "contact_duplicate_suggestions",
  ] as const;
  for (const table of tables) {
    fake.onInsert(table, () => void log.push(`insert:${table}`));
    fake.onUpdate(table, () => void log.push(`update:${table}`));
    fake.onUpsert(table, () => void log.push(`upsert:${table}`));
    fake.onDelete(table, () => void log.push(`delete:${table}`));
  }
  return log;
}

beforeEach(() => {
  fake.reset();
  for (const fn of Object.values(deps)) fn.mockReset();
  deps.getContactDecrypted.mockResolvedValue({ row: null, error: null });
  deps.setContactEncryptedFields.mockResolvedValue({ error: null });
});

/* -------------------------------------------------------------------------- */
/* The survivor's post-merge state                                             */
/* -------------------------------------------------------------------------- */

describe("mergeContactsManual — survivor state", () => {
  it("applies only allowlisted scalar picks and records the user's locks in manual_overrides", async () => {
    fake.seed("contacts", [
      { id: SURVIVOR, user_id: USER, name: "Jane Roe", company: null, manual_overrides: ["title"] },
      { id: LOSER, user_id: USER, name: "J. Roe", company: null, manual_overrides: [] },
    ]);

    const res = await mergeContactsManual({
      data: input({
        fields: { name: "Jane Roe", company: "Acme", user_id: "someone-else", id: "hijacked" },
        manualLockFields: ["name"],
      }),
      ...ctx,
    });

    expect(res).toStrictEqual({ survivorId: SURVIVOR, deletedCount: 1 });
    const survivor = fake.rows("contacts").find((c) => c.id === SURVIVOR)!;
    expect(survivor.name).toBe("Jane Roe");
    expect(survivor.company).toBe("Acme");
    // Non-allowlisted keys can never be written through `fields`.
    expect(survivor.user_id).toBe(USER);
    expect(survivor.id).toBe(SURVIVOR);
    // Previous locks are kept, the new lock added, and picking a company
    // locks "company" so enrichment stops overwriting the user's choice.
    expect([...(survivor.manual_overrides ?? [])].sort()).toStrictEqual([
      "company",
      "name",
      "title",
    ]);
  });

  it("replaces the survivor's emails and phones with the chosen set and mirrors the primary address", async () => {
    seedContacts();
    fake.seed("contact_emails", [
      { id: "e-old", user_id: USER, contact_id: SURVIVOR, label: "work", address: "old@x.test" },
      { id: "e-loser", user_id: USER, contact_id: LOSER, label: "work", address: "dup@x.test" },
    ]);
    fake.seed("contact_phones", [
      { id: "p-loser", user_id: USER, contact_id: LOSER, label: "work", number: "555-0000" },
    ]);

    await mergeContactsManual({
      data: input({
        emails: [
          { label: "Work", address: "  Jane@Acme.Test ", is_primary: false },
          { label: "", address: "jane.roe@acme.test", is_primary: true },
        ],
        phones: [{ label: "Mobile", number: " 555-1234 ", is_primary: false }],
      }),
      ...ctx,
    });

    expect(
      fake.rows("contact_emails").map((e) => ({
        contact_id: e.contact_id,
        label: e.label,
        address: e.address,
        is_primary: e.is_primary,
        position: e.position,
      })),
    ).toStrictEqual([
      {
        contact_id: SURVIVOR,
        label: "work",
        address: "jane@acme.test",
        is_primary: false,
        position: 0,
      },
      {
        contact_id: SURVIVOR,
        label: "other",
        address: "jane.roe@acme.test",
        is_primary: true,
        position: 1,
      },
    ]);
    // No primary was ticked among the phones, so the first row becomes it.
    expect(
      fake.rows("contact_phones").map((p) => ({
        contact_id: p.contact_id,
        label: p.label,
        number: p.number,
        is_primary: p.is_primary,
      })),
    ).toStrictEqual([
      { contact_id: SURVIVOR, label: "mobile", number: "555-1234", is_primary: true },
    ]);
    // contacts.email mirrors the chosen primary for legacy queries.
    expect(fake.rows("contacts").find((c) => c.id === SURVIVOR)?.email).toBe("jane.roe@acme.test");
  });

  it("carries the chosen source's notes onto the survivor", async () => {
    seedContacts();
    deps.getContactDecrypted.mockResolvedValue({
      row: decryptedContact({ id: LOSER, notes: "met at the conference" }),
      error: null,
    });

    await mergeContactsManual({ data: input({ notesSource: LOSER }), ...ctx });

    expect(deps.getContactDecrypted.mock.calls).toStrictEqual([[LOSER]]);
    expect(deps.setContactEncryptedFields.mock.calls).toStrictEqual([
      [{ contact_id: SURVIVOR, notes: "met at the conference" }],
    ]);
  });

  it("leaves the survivor's own notes alone when the chosen source has none", async () => {
    seedContacts();
    deps.getContactDecrypted.mockResolvedValue({
      row: decryptedContact({ id: LOSER, notes: null }),
      error: null,
    });

    await mergeContactsManual({ data: input({ notesSource: LOSER }), ...ctx });

    // `undefined` means LEAVE ALONE; an explicit null would CLEAR.
    expect(deps.setContactEncryptedFields.mock.calls).toStrictEqual([
      [{ contact_id: SURVIVOR, notes: undefined }],
    ]);
  });

  it("does not touch the encrypted notes when the survivor is its own notes source", async () => {
    seedContacts();

    await mergeContactsManual({ data: input({ notesSource: SURVIVOR }), ...ctx });

    expect(deps.getContactDecrypted).not.toHaveBeenCalled();
    expect(deps.setContactEncryptedFields).not.toHaveBeenCalled();
  });

  it("unions the losers' group memberships onto the survivor minus the excluded ones", async () => {
    seedContacts([SURVIVOR, LOSER, LOSER_2]);
    fake.seed("contact_group_members", [
      { user_id: USER, contact_id: SURVIVOR, group_id: GROUP_KEEP },
      { user_id: USER, contact_id: SURVIVOR, group_id: GROUP_DROP },
      { user_id: USER, contact_id: LOSER, group_id: GROUP_MOVE },
      { user_id: USER, contact_id: LOSER_2, group_id: GROUP_DROP },
    ]);

    await mergeContactsManual({
      data: input({ loserIds: [LOSER, LOSER_2], excludedGroupIds: [GROUP_DROP] }),
      ...ctx,
    });

    expect(
      fake
        .rows("contact_group_members")
        .filter((m) => m.contact_id === SURVIVOR)
        .map((m) => m.group_id)
        .sort(),
    ).toStrictEqual([GROUP_KEEP, GROUP_MOVE].sort());
  });
});

/* -------------------------------------------------------------------------- */
/* Reference transfers, tombstones and the delete-last invariant               */
/* -------------------------------------------------------------------------- */

describe("mergeContactsManual — reference transfers", () => {
  it("reassigns the non-cascaded references, tombstones each loser and bumps the CardDAV nonce", async () => {
    seedContacts([SURVIVOR, LOSER, LOSER_2]);
    fake.seed("contact_revisions", [
      { id: "rev-1", user_id: USER, contact_id: LOSER, source: "manual", snapshot: {} },
    ]);
    fake.seed("contact_cards_sent", [
      { id: "card-1", user_id: USER, contact_id: LOSER_2, to_email: "someone@x.test" },
    ]);
    fake.seed("carddav_settings", [{ user_id: USER, resync_nonce: 4 }]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));

    await mergeContactsManual({ data: input({ loserIds: [LOSER, LOSER_2] }), ...ctx });

    // History follows the survivor rather than dying with the loser rows.
    expect(fake.rows("contact_revisions").map((r) => r.contact_id)).toStrictEqual([SURVIVOR]);
    expect(fake.rows("contact_cards_sent").map((r) => r.contact_id)).toStrictEqual([SURVIVOR]);
    // One CardDAV tombstone per loser so iOS deletes its copies.
    expect(fake.rows("carddav_tombstones")).toStrictEqual([
      {
        user_id: USER,
        resource_type: "contact",
        resource_id: LOSER,
        deleted_at: "2026-09-02T12:00:00.000Z",
      },
      {
        user_id: USER,
        resource_type: "contact",
        resource_id: LOSER_2,
        deleted_at: "2026-09-02T12:00:00.000Z",
      },
    ]);
    expect(fake.rows("carddav_settings")).toStrictEqual([{ user_id: USER, resync_nonce: 5 }]);
    expect(fake.rows("contacts").map((c) => c.id)).toStrictEqual([SURVIVOR]);
    expect(
      deps.reconcileAutoParentsForContacts.mock.calls.map(([, userId, ids]) => [userId, ids]),
    ).toStrictEqual([[USER, [SURVIVOR]]]);
  });

  it("moves a reassignable Google link and tombstones only the colliding one", async () => {
    seedContacts();
    fake.seed("google_contact_links", [
      {
        id: "link-primary",
        user_id: USER,
        gmail_account_id: "acct-1",
        contact_id: SURVIVOR,
        resource_name: "people/survivor",
      },
      {
        id: "link-collision",
        user_id: USER,
        gmail_account_id: "acct-1",
        contact_id: LOSER,
        resource_name: "people/loser-1",
      },
      {
        id: "link-movable",
        user_id: USER,
        gmail_account_id: "acct-2",
        contact_id: LOSER,
        resource_name: "people/loser-2",
      },
    ]);

    await mergeContactsManual({ data: input(), ...ctx });

    // The acct-1 link would collide with the survivor's own, so it is
    // dropped locally and tombstoned for the Google push.
    expect(
      fake.rows("google_contact_links").map((l) => [l.resource_name, l.contact_id]),
    ).toStrictEqual([
      ["people/survivor", SURVIVOR],
      ["people/loser-2", SURVIVOR],
    ]);
    // kind must be 'contact' — the table CHECK allows ('contact','group')
    // only, and a rejected insert leaves the Google duplicate alive.
    expect(fake.rows("google_contact_tombstones")).toStrictEqual([
      {
        user_id: USER,
        gmail_account_id: "acct-1",
        kind: "contact",
        resource_name: "people/loser-1",
      },
    ]);
  });

  it("never tombstones a link it reassigned — that link is now the survivor's Google identity", async () => {
    seedContacts();
    fake.seed("google_contact_links", [
      {
        id: "link-movable",
        user_id: USER,
        gmail_account_id: "acct-2",
        contact_id: LOSER,
        resource_name: "people/loser-2",
      },
    ]);

    await mergeContactsManual({ data: input(), ...ctx });

    expect(fake.rows("google_contact_tombstones")).toStrictEqual([]);
    expect(fake.rows("google_contact_links").map((l) => l.contact_id)).toStrictEqual([SURVIVOR]);
  });

  it("deletes the losers only after every transfer has succeeded", async () => {
    seedContacts();
    fake.seed("contact_revisions", [
      { id: "rev-1", user_id: USER, contact_id: LOSER, source: "manual", snapshot: {} },
    ]);
    fake.seed("contact_group_members", [
      { user_id: USER, contact_id: LOSER, group_id: GROUP_MOVE },
    ]);
    fake.seed("google_contact_links", [
      {
        id: "link-collision",
        user_id: USER,
        gmail_account_id: "acct-1",
        contact_id: SURVIVOR,
        resource_name: "people/survivor",
      },
      {
        id: "link-loser",
        user_id: USER,
        gmail_account_id: "acct-1",
        contact_id: LOSER,
        resource_name: "people/loser-1",
      },
    ]);
    const log = trackWriteOrder();

    await mergeContactsManual({
      data: input({
        emails: [{ label: "work", address: "jane@acme.test", is_primary: true }],
      }),
      ...ctx,
    });

    const deletedLosersAt = log.lastIndexOf("delete:contacts");
    expect(deletedLosersAt).toBeGreaterThan(-1);
    for (const transfer of [
      "upsert:contact_group_members",
      "update:contact_revisions",
      "update:contact_cards_sent",
      "delete:google_contact_links",
      "upsert:carddav_tombstones",
      "insert:google_contact_tombstones",
      "insert:contact_emails",
    ]) {
      const at = log.indexOf(transfer);
      expect(at, `${transfer} never ran`).toBeGreaterThan(-1);
      expect(at, `${transfer} must run before the losers are deleted`).toBeLessThan(
        deletedLosersAt,
      );
    }
    // …and the CardDAV resync bump comes after, so iOS only re-reads once
    // the book is actually in its final state.
    expect(log.indexOf("upsert:carddav_settings")).toBeGreaterThan(deletedLosersAt);
  });
});

/* -------------------------------------------------------------------------- */
/* Fail-recovery: a failed transfer must leave the losers intact               */
/* -------------------------------------------------------------------------- */

describe("mergeContactsManual — fail-recovery", () => {
  const failures: Array<{
    name: string;
    inject: () => void;
    message: RegExp;
    seed?: () => void;
  }> = [
    {
      name: "the survivor's scalar update",
      inject: () => fake.onUpdate("contacts", () => ({ message: "boom" })),
      message: /Failed to update survivor/,
    },
    {
      name: "clearing the old emails",
      inject: () => fake.onDelete("contact_emails", () => ({ message: "boom" })),
      message: /Failed to clear emails/,
    },
    {
      name: "inserting the chosen emails",
      inject: () => fake.onInsert("contact_emails", () => ({ message: "boom" })),
      message: /Failed to insert emails/,
    },
    {
      name: "clearing the old phones",
      inject: () => fake.onDelete("contact_phones", () => ({ message: "boom" })),
      message: /Failed to clear phones/,
    },
    {
      name: "moving the group memberships",
      seed: () =>
        fake.seed("contact_group_members", [
          { user_id: USER, contact_id: LOSER, group_id: GROUP_MOVE },
        ]),
      inject: () => fake.onUpsert("contact_group_members", () => ({ message: "boom" })),
      message: /Failed to move memberships/,
    },
    {
      name: "reassigning the revision history",
      inject: () => fake.onUpdate("contact_revisions", () => ({ message: "boom" })),
      message: /Failed to reassign contact_revisions/,
    },
    {
      name: "writing the CardDAV tombstones",
      inject: () => fake.onUpsert("carddav_tombstones", () => ({ message: "boom" })),
      message: /Failed to write CardDAV tombstones/,
    },
  ];

  for (const failure of failures) {
    it(`leaves every loser row in place when ${failure.name} fails`, async () => {
      seedContacts();
      failure.seed?.();
      failure.inject();

      await expect(
        mergeContactsManual({
          data: input({
            fields: { name: "Jane Roe" },
            emails: [{ label: "work", address: "jane@acme.test", is_primary: true }],
          }),
          ...ctx,
        }),
      ).rejects.toThrow(failure.message);

      expect(
        fake
          .rows("contacts")
          .map((c) => c.id)
          .sort(),
      ).toStrictEqual([SURVIVOR, LOSER].sort());
      expect(deps.reconcileAutoParentsForContacts).not.toHaveBeenCalled();
    });
  }

  it("surfaces a failed loser delete instead of reporting a successful merge", async () => {
    seedContacts();
    fake.onDelete("contacts", () => ({ message: "foreign key still referenced" }));

    await expect(mergeContactsManual({ data: input(), ...ctx })).rejects.toThrow(
      /Failed to delete losers/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Suggestion bookkeeping                                                      */
/* -------------------------------------------------------------------------- */

describe("mergeContactsManual — suggestion bookkeeping", () => {
  it("marks the survivor's and the losers' duplicate suggestions merged", async () => {
    seedContacts();
    fake.seed("contact_duplicate_suggestions", [
      { id: "sug-survivor", user_id: USER, primary_contact_id: SURVIVOR, status: "pending" },
      { id: "sug-loser", user_id: USER, primary_contact_id: LOSER, status: "pending" },
      {
        id: "sug-other-user",
        user_id: "someone-else",
        primary_contact_id: SURVIVOR,
        status: "pending",
      },
    ]);

    await mergeContactsManual({ data: input(), ...ctx });

    expect(fake.rows("contact_duplicate_suggestions").map((s) => [s.id, s.status])).toStrictEqual([
      ["sug-survivor", "merged"],
      ["sug-loser", "merged"],
      ["sug-other-user", "pending"],
    ]);
  });
});
