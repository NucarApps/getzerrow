// Contact revision snapshot/restore (revisions.server.ts) and its server
// fns (revisions.functions.ts). Contracts protected:
//
//   * snapshotContact runs on the service-role client and takes its contact
//     from a SECURITY DEFINER decrypt RPC, so the in-helper user_id check is
//     the whole guard: a foreign contact id snapshots NOTHING, silently,
//   * restoreContactFromRevision scopes the revision read by (id, user_id)
//     and reports "Revision not found" for another tenant's revision, with
//     zero writes,
//   * a restore replays the snapshot EXACTLY: an encrypted field that was
//     empty at snapshot time is written as an explicit null (clear), never
//     omitted (which the RPC reads as "leave alone" and would resurrect the
//     current value),
//   * a snapshot group_id whose group has since been deleted is dropped
//     rather than FK-failing the batch and wiping every label,
//   * each write step is error-checked: a failure short-circuits with the
//     message instead of continuing into the destructive steps.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { makeContactRow, makeGroupRow } from "./__fixtures__/rows";

const fake = makeSupabaseFake();
const rls = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const getContactDecrypted = vi.fn(async () => ({
  row: null as Record<string, unknown> | null,
  error: null as string | null,
}));
vi.mock("@/lib/sync/encrypted-reader", () => ({
  getContactDecrypted: (...a: unknown[]) => getContactDecrypted(...(a as [])),
}));

const setContactEncryptedFields = vi.fn(async () => ({ error: null as string | null }));
vi.mock("@/lib/sync/encrypted-writer", () => ({
  setContactEncryptedFields: (...a: unknown[]) => setContactEncryptedFields(...(a as [])),
}));

import { snapshotContact, restoreContactFromRevision } from "./revisions.server";
import { listContactRevisions, restoreContactRevision } from "./revisions.functions";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const VICTIM = "victim-user-2";
const ATTACKER = "attacker-user-9";

type CallArgs = { data?: unknown; context?: Record<string, unknown> };
function call(fn: unknown, args: CallArgs): Promise<never> {
  return (fn as (a: CallArgs) => Promise<never>)(args);
}
const asUser = { supabase: rls.supabaseAdmin };

function decrypted(over: Record<string, unknown> = {}) {
  return {
    ...makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, name: "Ada Lovelace" }),
    phone: "+14155550100",
    notes: "met at conf",
    address_line1: "1 Analytical Way",
    address_line2: null,
    relationship_summary: null,
    ...over,
  };
}

type SnapshotPhone = {
  label: string | null;
  number: string;
  is_primary: boolean;
  position: number;
};

/** A snapshot payload as snapshotContact would have written it. */
function snapshot(
  over: {
    contact?: Record<string, string | number | boolean | null>;
    phones?: SnapshotPhone[];
    group_ids?: string[];
  } = {},
) {
  return {
    contact: { ...decrypted(), ...(over.contact ?? {}) },
    phones: over.phones ?? [
      { label: "Mobile", number: "+14155550100", is_primary: true, position: 0 },
    ],
    group_ids: over.group_ids ?? [GROUP_ID],
  };
}

beforeEach(() => {
  fake.reset();
  rls.reset();
  getContactDecrypted.mockReset();
  getContactDecrypted.mockResolvedValue({ row: decrypted(), error: null });
  setContactEncryptedFields.mockReset();
  setContactEncryptedFields.mockResolvedValue({ error: null });
});

describe("snapshotContact", () => {
  it("silently records nothing for a contact owned by another tenant", async () => {
    getContactDecrypted.mockResolvedValue({ row: decrypted({ user_id: VICTIM }), error: null });
    await expect(snapshotContact(ATTACKER, CONTACT_ID, "carddav_put")).resolves.toBeUndefined();
    expect(writeCount(fake)).toBe(0);
    expect(fake.calls.selects).toHaveLength(0);
  });

  it("captures the decrypted contact, its phones and its group ids", async () => {
    fake.seed("contact_phones", [
      {
        id: "p1",
        user_id: TEST_USER,
        contact_id: CONTACT_ID,
        label: "mobile",
        number: "+14155550100",
        is_primary: true,
        position: 0,
      },
    ]);
    fake.seed("contact_group_members", [
      { user_id: TEST_USER, contact_id: CONTACT_ID, group_id: GROUP_ID },
    ]);

    await snapshotContact(TEST_USER, CONTACT_ID, "carddav_put");

    const ins = fake.calls.inserts.find((i) => i.table === "contact_revisions")!;
    const payload = ins.payload as {
      user_id: string;
      contact_id: string;
      source: string;
      snapshot: { contact: { name: string }; phones: unknown[]; group_ids: string[] };
    };
    expect(payload.user_id).toBe(TEST_USER);
    expect(payload.contact_id).toBe(CONTACT_ID);
    expect(payload.source).toBe("carddav_put");
    expect(payload.snapshot.contact.name).toBe("Ada Lovelace");
    expect(payload.snapshot.phones).toStrictEqual([
      { label: "mobile", number: "+14155550100", is_primary: true, position: 0 },
    ]);
    expect(payload.snapshot.group_ids).toStrictEqual([GROUP_ID]);
    // Every read is scoped to the owner as well as the contact.
    for (const sel of fake.calls.selects.slice(0, 2)) {
      expect(sel.filters).toContainEqual({
        op: "eq",
        col: "user_id",
        value: TEST_USER,
        extra: undefined,
      });
    }
  });

  it("trims the history beyond the retention cap, scoped to the owner", async () => {
    // 22 existing revisions, newest first: the two oldest fall outside the
    // 20-row retention window and are the ones deleted.
    fake.seed(
      "contact_revisions",
      Array.from({ length: 22 }, (_, i) => ({
        id: `rev-${i}`,
        user_id: TEST_USER,
        contact_id: CONTACT_ID,
        source: "manual",
        created_at: `2026-02-${String(22 - i).padStart(2, "0")}T00:00:00Z`,
      })),
    );
    await snapshotContact(TEST_USER, CONTACT_ID, "manual");
    const del = fake.calls.deletes.find((d) => d.table === "contact_revisions")!;
    expect(del.filters).toStrictEqual([
      { op: "in", col: "id", value: ["rev-20", "rev-21"], extra: undefined },
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
    ]);
  });
});

describe("restoreContactFromRevision", () => {
  it("refuses another tenant's revision with zero writes", async () => {
    fake.seed("contact_revisions", [
      { id: REVISION_ID, user_id: VICTIM, contact_id: CONTACT_ID, source: "manual" },
    ]);
    const res = await restoreContactFromRevision(ATTACKER, REVISION_ID);
    expect(res).toStrictEqual({ ok: false, error: "Revision not found" });
    expect(writeCount(fake)).toBe(0);
    expect(setContactEncryptedFields).not.toHaveBeenCalled();
  });

  it("clears an encrypted field that was empty in the snapshot instead of leaving it alone", async () => {
    // `undefined` means "keep" to the encrypted writer, so replaying a
    // snapshot with an empty note MUST send an explicit null — otherwise the
    // note the user added after the snapshot survives the restore.
    fake.seed("contact_revisions", [
      {
        id: REVISION_ID,
        user_id: TEST_USER,
        contact_id: CONTACT_ID,
        snapshot: snapshot({
          contact: { notes: null, phone: null, address_line1: null, address_line2: null },
        }),
      },
    ]);
    fake.seed("contact_groups", [makeGroupRow({ id: GROUP_ID, user_id: TEST_USER })]);

    const res = await restoreContactFromRevision(TEST_USER, REVISION_ID);
    expect(res).toStrictEqual({ ok: true, error: null });
    expect(setContactEncryptedFields).toHaveBeenCalledWith({
      contact_id: CONTACT_ID,
      notes: null,
      address_line1: null,
      address_line2: null,
      phone: null,
    });
  });

  it("replays the plaintext columns, the phones and the memberships", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    fake.seed("contact_revisions", [
      {
        id: REVISION_ID,
        user_id: TEST_USER,
        contact_id: CONTACT_ID,
        snapshot: snapshot({ contact: { title: "Chief Engineer", company: "Acme" } }),
      },
    ]);
    fake.seed("contact_groups", [makeGroupRow({ id: GROUP_ID, user_id: TEST_USER })]);

    await restoreContactFromRevision(TEST_USER, REVISION_ID);

    const upd = fake.calls.updates.find((u) => u.table === "contacts")!;
    expect(upd.payload).toStrictEqual({
      name: "Ada Lovelace",
      email: "ada@acme.com",
      title: "Chief Engineer",
      company: "Acme",
      website: null,
      city: null,
      region: null,
      postal_code: null,
      country: null,
      linkedin: null,
      twitter: null,
      updated_at: "2026-03-01T12:00:00.000Z",
    });
    expect(upd.filters).toStrictEqual([
      { op: "eq", col: "id", value: CONTACT_ID, extra: undefined },
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
    ]);
    const phoneIns = fake.calls.inserts.find((i) => i.table === "contact_phones")!;
    expect(phoneIns.payload).toStrictEqual([
      {
        user_id: TEST_USER,
        contact_id: CONTACT_ID,
        label: "mobile", // lowercased from the snapshot's "Mobile"
        number: "+14155550100",
        is_primary: true,
        position: 0,
      },
    ]);
    const memberUpsert = fake.calls.upserts.find((u) => u.table === "contact_group_members")!;
    expect(memberUpsert.payload).toStrictEqual([
      { user_id: TEST_USER, contact_id: CONTACT_ID, group_id: GROUP_ID },
    ]);
    // Memberships outside the snapshot are pruned.
    const memberDelete = fake.calls.deletes.find((d) => d.table === "contact_group_members")!;
    expect(memberDelete.filters).toStrictEqual([
      { op: "eq", col: "contact_id", value: CONTACT_ID, extra: undefined },
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
      { op: "not", col: "group_id", value: `(${GROUP_ID})`, extra: "in" },
    ]);
    vi.useRealTimers();
  });

  it("drops a snapshot group that no longer exists rather than failing the restore", async () => {
    fake.seed("contact_revisions", [
      {
        id: REVISION_ID,
        user_id: TEST_USER,
        contact_id: CONTACT_ID,
        snapshot: snapshot({ group_ids: [GROUP_ID] }),
      },
    ]);
    // No contact_groups row: the group was deleted since the snapshot.
    const res = await restoreContactFromRevision(TEST_USER, REVISION_ID);
    expect(res).toStrictEqual({ ok: true, error: null });
    expect(fake.calls.upserts.filter((u) => u.table === "contact_group_members")).toHaveLength(0);
    // With nothing to keep, the prune uses the sentinel id so it does not
    // become an unbounded "delete everything".
    const memberDelete = fake.calls.deletes.find((d) => d.table === "contact_group_members")!;
    expect(memberDelete.filters.at(-1)).toStrictEqual({
      op: "not",
      col: "group_id",
      value: "('00000000-0000-0000-0000-000000000000')",
      extra: "in",
    });
  });

  it("a failing contacts UPDATE stops before the destructive phone delete", async () => {
    fake.seed("contact_revisions", [
      { id: REVISION_ID, user_id: TEST_USER, contact_id: CONTACT_ID, snapshot: snapshot() },
    ]);
    fake.onUpdate("contacts", () => ({ message: "deadlock detected" }));
    const res = await restoreContactFromRevision(TEST_USER, REVISION_ID);
    expect(res).toStrictEqual({ ok: false, error: "deadlock detected" });
    expect(fake.calls.deletes.filter((d) => d.table === "contact_phones")).toHaveLength(0);
  });

  it("a failing phone insert surfaces instead of leaving the contact phone-less", async () => {
    fake.seed("contact_revisions", [
      { id: REVISION_ID, user_id: TEST_USER, contact_id: CONTACT_ID, snapshot: snapshot() },
    ]);
    fake.onInsert("contact_phones", () => ({ message: "check constraint violated" }));
    const res = await restoreContactFromRevision(TEST_USER, REVISION_ID);
    expect(res).toStrictEqual({ ok: false, error: "check constraint violated" });
  });

  it("a failing encrypted write stops the restore", async () => {
    fake.seed("contact_revisions", [
      { id: REVISION_ID, user_id: TEST_USER, contact_id: CONTACT_ID, snapshot: snapshot() },
    ]);
    setContactEncryptedFields.mockResolvedValue({ error: "encryption key missing" });
    const res = await restoreContactFromRevision(TEST_USER, REVISION_ID);
    expect(res).toStrictEqual({ ok: false, error: "encryption key missing" });
    expect(fake.calls.deletes.filter((d) => d.table === "contact_phones")).toHaveLength(0);
  });
});

describe("listContactRevisions", () => {
  it("projects the snapshot's contact name and email out of each row", async () => {
    rls.seed("contact_revisions", [
      {
        id: REVISION_ID,
        user_id: TEST_USER,
        contact_id: CONTACT_ID,
        source: "carddav_put",
        created_at: "2026-02-01T00:00:00Z",
        snapshot: { contact: { name: "Ada Lovelace", email: "ada@acme.com" } },
      },
    ]);
    const res = (await call(listContactRevisions, {
      data: { contactId: CONTACT_ID },
      context: asUser,
    })) as unknown as Array<Record<string, unknown>>;
    expect(res).toStrictEqual([
      {
        id: REVISION_ID,
        source: "carddav_put",
        created_at: "2026-02-01T00:00:00Z",
        contact_name: "Ada Lovelace",
        contact_email: "ada@acme.com",
      },
    ]);
    // RLS-RELIANCE: the read filters by contact_id only — a foreign contact
    // id is stopped by the policy, not by this handler.
    expect(rls.calls.selects[0]!.filters).toStrictEqual([
      { op: "eq", col: "contact_id", value: CONTACT_ID, extra: undefined },
    ]);
  });

  it("a snapshot without a contact block degrades to nulls", async () => {
    rls.seed("contact_revisions", [
      {
        id: REVISION_ID,
        user_id: TEST_USER,
        contact_id: CONTACT_ID,
        source: "manual",
        created_at: "2026-02-01T00:00:00Z",
        snapshot: null,
      },
    ]);
    const res = (await call(listContactRevisions, {
      data: { contactId: CONTACT_ID },
      context: asUser,
    })) as unknown as Array<{ contact_name: string | null }>;
    expect(res[0]!.contact_name).toBeNull();
  });

  it("a failing read surfaces to the caller", async () => {
    rls.onSelect("contact_revisions", () => ({ message: "statement timeout" }));
    await expect(
      call(listContactRevisions, { data: { contactId: CONTACT_ID }, context: asUser }),
    ).rejects.toThrow("statement timeout");
  });
});

describe("restoreContactRevision", () => {
  it("another tenant's revision is refused with zero writes", async () => {
    fake.seed("contact_revisions", [
      { id: REVISION_ID, user_id: VICTIM, contact_id: CONTACT_ID, snapshot: snapshot() },
    ]);
    await expect(
      call(restoreContactRevision, {
        data: { revisionId: REVISION_ID },
        context: { ...asUser, userId: ATTACKER },
      }),
    ).rejects.toThrow("Revision not found");
    expect(writeCount(fake)).toBe(0);
  });

  it("zod rejects a non-uuid revision id", async () => {
    await expect(restoreContactRevision({ data: { revisionId: "nope" } })).rejects.toThrow();
    expect(writeCount(fake)).toBe(0);
  });
});
