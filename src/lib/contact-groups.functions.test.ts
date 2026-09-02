// Contact group (label) server fns (contact-groups.functions.ts).
// Contracts protected:
//
//   * linkContactGroupToFolder verifies BOTH ids against the caller before
//     touching anything — a foreign group or a foreign folder is refused
//     with zero writes (it is the one fn here with an app-level guard, and
//     it writes a folder_filters row, so the guard is load-bearing),
//   * every auto-generated company subgroup is read-only to these fns:
//     edit / delete / membership writes are refused before any write,
//   * createContactGroup routes through the alias-aware label resolver, so
//     a near-duplicate name returns the existing label instead of minting a
//     second one, and the insert pins user_id, a default colour and a
//     CardDAV uid,
//   * updateContactGroup refuses a self-parent, a cycle, and a nesting
//     depth over the limit,
//   * membership writes pin user_id from the authenticated context.
//
// TENANT-ISOLATION NOTE: except for linkContactGroupToFolder, every query
// runs on the user-scoped `context.supabase` and filters by id only — the
// isolation is RLS-reliant and belongs to the DB-backed integration sweep.
// The filters are pinned below (marked RLS-RELIANCE) so adding a user_id
// predicate is a deliberate change rather than an accident.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";
import { makeGroupRow, makeGroupMemberRow } from "./contacts/__fixtures__/rows";

const rls = makeSupabaseFake({ applyWrites: true });

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

const reconcileIfAuto = vi.fn(async () => {});
vi.mock("./contacts/auto-company-subgroups.functions", () => ({
  reconcileIfAuto: (...a: unknown[]) => reconcileIfAuto(...(a as [])),
}));

import {
  listContactGroups,
  createContactGroup,
  updateContactGroup,
  deleteContactGroup,
  setContactGroups,
  addContactsToGroups,
  linkContactGroupToFolder,
} from "./contact-groups.functions";

const GROUP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FOLDER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONTACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VICTIM = "victim-user-2";
const ATTACKER = "attacker-user-9";

type CallArgs = { data?: unknown; context?: Record<string, unknown> };
function call(fn: unknown, args: CallArgs): Promise<never> {
  return (fn as (a: CallArgs) => Promise<never>)(args);
}
const asUser = { supabase: rls.supabaseAdmin };
const asAttacker = { supabase: rls.supabaseAdmin, userId: ATTACKER };

beforeEach(() => {
  rls.reset();
  reconcileIfAuto.mockClear();
});

describe("linkContactGroupToFolder", () => {
  it("another tenant's group is not found, and nothing is written", async () => {
    rls.seed("contact_groups", [makeGroupRow({ id: GROUP_ID, user_id: VICTIM })]);
    rls.seed("folders", [{ id: FOLDER_ID, user_id: ATTACKER, name: "Mine" }]);
    await expectDeniedCrossUser({
      fake: rls,
      rejects: "Group not found",
      call: () =>
        call(linkContactGroupToFolder, {
          data: { groupId: GROUP_ID, folderId: FOLDER_ID },
          context: asAttacker,
        }),
    });
  });

  it("another tenant's folder is not found, and nothing is written", async () => {
    rls.seed("contact_groups", [makeGroupRow({ id: GROUP_ID, user_id: ATTACKER })]);
    rls.seed("folders", [{ id: FOLDER_ID, user_id: VICTIM, name: "Theirs" }]);
    await expectDeniedCrossUser({
      fake: rls,
      rejects: "Folder not found",
      call: () =>
        call(linkContactGroupToFolder, {
          data: { groupId: GROUP_ID, folderId: FOLDER_ID },
          context: asAttacker,
        }),
    });
  });

  it("linking replaces any previous sender_in_group filter and stamps the link", async () => {
    rls.seed("contact_groups", [makeGroupRow({ id: GROUP_ID, user_id: TEST_USER })]);
    rls.seed("folders", [{ id: FOLDER_ID, user_id: TEST_USER, name: "Clients" }]);

    const res = await call(linkContactGroupToFolder, {
      data: { groupId: GROUP_ID, folderId: FOLDER_ID },
      context: asUser,
    });
    expect(res).toEqual({ ok: true });
    expect(rls.calls.deletes).toStrictEqual([
      {
        table: "folder_filters",
        payload: null,
        options: undefined,
        filters: [
          { op: "eq", col: "op", value: "sender_in_group", extra: undefined },
          { op: "eq", col: "value", value: GROUP_ID, extra: undefined },
        ],
      },
    ]);
    expect(rls.calls.updates[0]!.payload).toStrictEqual({ folder_id: FOLDER_ID });
    expect(rls.calls.inserts).toStrictEqual([
      {
        table: "folder_filters",
        payload: {
          folder_id: FOLDER_ID,
          field: "from",
          op: "sender_in_group",
          value: GROUP_ID,
        },
        options: undefined,
        filters: [],
      },
    ]);
  });

  it("unlinking clears the link and leaves no filter row behind", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: GROUP_ID, user_id: TEST_USER, folder_id: FOLDER_ID }),
    ]);
    await call(linkContactGroupToFolder, {
      data: { groupId: GROUP_ID, folderId: null },
      context: asUser,
    });
    expect(rls.calls.updates[0]!.payload).toStrictEqual({ folder_id: null });
    expect(rls.calls.inserts).toHaveLength(0);
  });

  it("a failing filter delete aborts before the group link is changed", async () => {
    rls.seed("contact_groups", [makeGroupRow({ id: GROUP_ID, user_id: TEST_USER })]);
    rls.onDelete("folder_filters", () => ({ message: "permission denied" }));
    await expect(
      call(linkContactGroupToFolder, {
        data: { groupId: GROUP_ID, folderId: null },
        context: asUser,
      }),
    ).rejects.toThrow("permission denied");
    expect(rls.calls.updates).toHaveLength(0);
  });
});

describe("createContactGroup", () => {
  it("inserts with user_id pinned, the default colour and a CardDAV uid", async () => {
    const res = (await call(createContactGroup, {
      data: { name: "  Clients  " },
      context: asUser,
    })) as unknown as { group: unknown };
    expect(res.group).toBeDefined();
    const ins = rls.calls.inserts.find((i) => i.table === "contact_groups")!;
    expect(ins.payload).toStrictEqual({
      user_id: TEST_USER,
      name: "Clients",
      color: "#6366f1",
      carddav_uid: expect.stringMatching(/^group-/),
      parent_group_id: null,
    });
  });

  it("an alias-equivalent name resolves to the existing label instead of a duplicate", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: GROUP_ID, user_id: TEST_USER, name: "Nissan" }),
    ]);
    const res = (await call(createContactGroup, {
      data: { name: "Nissan, Inc." },
      context: asUser,
    })) as unknown as { group: { id: string } };
    expect(res.group.id).toBe(GROUP_ID);
    expect(writeCount(rls)).toBe(0);
  });

  it("refuses to nest past the depth limit", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: "g1", user_id: TEST_USER, parent_group_id: null }),
      makeGroupRow({ id: "g2", user_id: TEST_USER, parent_group_id: "g1" }),
      makeGroupRow({ id: "g3", user_id: TEST_USER, parent_group_id: "g2" }),
      makeGroupRow({ id: PARENT_ID, user_id: TEST_USER, parent_group_id: "g3" }),
    ]);
    await expect(
      call(createContactGroup, {
        data: { name: "Too deep", parent_group_id: PARENT_ID },
        context: asUser,
      }),
    ).rejects.toThrow("only nest 4 levels deep");
    expect(writeCount(rls)).toBe(0);
  });

  it("a unique-name race returns the winning row rather than failing the create", async () => {
    // The race: the resolver's candidate read sees nothing (the winner has
    // not committed yet), the INSERT then trips the unique index, and the
    // fallback lookup finds the row the other request wrote.
    const winner = makeGroupRow({ id: GROUP_ID, user_id: TEST_USER, name: "Clients" });
    let groupReads = 0;
    rls.onSelect("contact_groups", () => ({ data: groupReads++ === 0 ? [] : [winner] }));
    rls.onInsert("contact_groups", () => ({ message: "duplicate key value", code: "23505" }));

    const res = (await call(createContactGroup, {
      data: { name: "Clients" },
      context: asUser,
    })) as unknown as { group: { id: string } };
    expect(res.group.id).toBe(GROUP_ID);
    expect(groupReads, "the fallback lookup must actually run").toBe(2);
  });

  it("a create that fails for any other reason surfaces the error", async () => {
    rls.onInsert("contact_groups", () => ({ message: "column color is null" }));
    await expect(
      call(createContactGroup, { data: { name: "Clients" }, context: asUser }),
    ).rejects.toThrow("column color is null");
  });

  it("zod rejects an empty name, an oversize name and a malformed colour", async () => {
    await expect(createContactGroup({ data: { name: "" } })).rejects.toThrow();
    await expect(createContactGroup({ data: { name: "x".repeat(61) } })).rejects.toThrow();
    await expect(createContactGroup({ data: { name: "ok", color: "red" } })).rejects.toThrow();
    expect(writeCount(rls)).toBe(0);
  });
});

describe("updateContactGroup", () => {
  it("refuses to edit a reconciler-managed auto subgroup", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({
        id: GROUP_ID,
        user_id: TEST_USER,
        auto_generated_from_group_id: PARENT_ID,
      }),
    ]);
    await expect(
      call(updateContactGroup, { data: { id: GROUP_ID, name: "New" }, context: asUser }),
    ).rejects.toThrow("managed automatically");
    expect(writeCount(rls)).toBe(0);
  });

  it("refuses a self-parent and a cycle", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: GROUP_ID, user_id: TEST_USER }),
      makeGroupRow({ id: PARENT_ID, user_id: TEST_USER, parent_group_id: GROUP_ID }),
    ]);
    await expect(
      call(updateContactGroup, {
        data: { id: GROUP_ID, parent_group_id: GROUP_ID },
        context: asUser,
      }),
    ).rejects.toThrow("its own parent");
    await expect(
      call(updateContactGroup, {
        data: { id: GROUP_ID, parent_group_id: PARENT_ID },
        context: asUser,
      }),
    ).rejects.toThrow("create a cycle");
    expect(writeCount(rls)).toBe(0);
  });

  it("renames and re-parents in one patch, scoped by id (RLS-reliant)", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: GROUP_ID, user_id: TEST_USER }),
      makeGroupRow({ id: PARENT_ID, user_id: TEST_USER }),
    ]);
    await call(updateContactGroup, {
      data: { id: GROUP_ID, name: "Renamed", color: "#00ff00", parent_group_id: PARENT_ID },
      context: asUser,
    });
    const upd = rls.calls.updates.find((u) => u.table === "contact_groups")!;
    expect(upd.payload).toStrictEqual({
      name: "Renamed",
      color: "#00ff00",
      parent_group_id: PARENT_ID,
    });
    // RLS-RELIANCE: no user_id predicate on the UPDATE.
    expect(upd.filters).toStrictEqual([{ op: "eq", col: "id", value: GROUP_ID, extra: undefined }]);
  });

  it("a failing update surfaces to the caller", async () => {
    rls.seed("contact_groups", [makeGroupRow({ id: GROUP_ID, user_id: TEST_USER })]);
    rls.onUpdate("contact_groups", () => ({ message: "duplicate key value" }));
    await expect(
      call(updateContactGroup, { data: { id: GROUP_ID, name: "Dup" }, context: asUser }),
    ).rejects.toThrow("duplicate key value");
  });
});

describe("deleteContactGroup", () => {
  it("refuses to delete a reconciler-managed auto subgroup", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({
        id: GROUP_ID,
        user_id: TEST_USER,
        auto_generated_from_group_id: PARENT_ID,
      }),
    ]);
    await expect(
      call(deleteContactGroup, { data: { id: GROUP_ID }, context: asUser }),
    ).rejects.toThrow("managed automatically");
    expect(writeCount(rls)).toBe(0);
  });

  it("deletes by id on the user-scoped client (RLS-reliant, no user_id filter)", async () => {
    rls.seed("contact_groups", [makeGroupRow({ id: GROUP_ID, user_id: TEST_USER })]);
    const res = await call(deleteContactGroup, { data: { id: GROUP_ID }, context: asUser });
    expect(res).toEqual({ ok: true });
    expect(rls.calls.deletes).toStrictEqual([
      {
        table: "contact_groups",
        payload: null,
        options: undefined,
        // RLS-RELIANCE: id only.
        filters: [{ op: "eq", col: "id", value: GROUP_ID, extra: undefined }],
      },
    ]);
  });

  it("a failing delete surfaces to the caller", async () => {
    rls.seed("contact_groups", [makeGroupRow({ id: GROUP_ID, user_id: TEST_USER })]);
    rls.onDelete("contact_groups", () => ({ message: "foreign key violation" }));
    await expect(
      call(deleteContactGroup, { data: { id: GROUP_ID }, context: asUser }),
    ).rejects.toThrow("foreign key violation");
  });
});

describe("setContactGroups", () => {
  it("refuses when any target is an auto-generated subgroup, writing nothing", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: GROUP_ID, user_id: TEST_USER, auto_generated_from_group_id: PARENT_ID }),
    ]);
    await expect(
      call(setContactGroups, {
        data: { contactId: CONTACT_ID, groupIds: [GROUP_ID] },
        context: asUser,
      }),
    ).rejects.toThrow("managed automatically");
    expect(writeCount(rls)).toBe(0);
  });

  it("replaces the contact's memberships and pins user_id on the new rows", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: GROUP_ID, user_id: TEST_USER }),
      makeGroupRow({ id: PARENT_ID, user_id: TEST_USER }),
    ]);
    rls.seed("contact_group_members", [
      makeGroupMemberRow({ group_id: PARENT_ID, contact_id: CONTACT_ID, user_id: TEST_USER }),
    ]);

    const res = await call(setContactGroups, {
      data: { contactId: CONTACT_ID, groupIds: [GROUP_ID] },
      context: asUser,
    });
    expect(res).toEqual({ ok: true });
    expect(rls.calls.deletes[0]!.filters).toStrictEqual([
      { op: "eq", col: "contact_id", value: CONTACT_ID, extra: undefined },
      { op: "in", col: "group_id", value: [PARENT_ID], extra: undefined },
    ]);
    const up = rls.calls.upserts.find((u) => u.table === "contact_group_members")!;
    expect(up.payload).toStrictEqual([
      { group_id: GROUP_ID, contact_id: CONTACT_ID, user_id: TEST_USER },
    ]);
    expect(up.options).toStrictEqual({ onConflict: "group_id,contact_id", ignoreDuplicates: true });
    // Both the group lost and the group gained get an auto-parent reconcile.
    expect(reconcileIfAuto.mock.calls.map((c) => (c as unknown[])[2])).toStrictEqual([
      PARENT_ID,
      GROUP_ID,
    ]);
  });

  it("an empty group list clears every membership without upserting", async () => {
    rls.seed("contact_group_members", [
      makeGroupMemberRow({ group_id: GROUP_ID, contact_id: CONTACT_ID, user_id: TEST_USER }),
    ]);
    await call(setContactGroups, {
      data: { contactId: CONTACT_ID, groupIds: [] },
      context: asUser,
    });
    expect(rls.calls.upserts).toHaveLength(0);
    expect(rls.rows("contact_group_members")).toHaveLength(0);
  });

  it("a failing membership upsert surfaces to the caller", async () => {
    rls.seed("contact_groups", [makeGroupRow({ id: GROUP_ID, user_id: TEST_USER })]);
    rls.onUpsert("contact_group_members", () => ({ message: "insert violates policy" }));
    await expect(
      call(setContactGroups, {
        data: { contactId: CONTACT_ID, groupIds: [GROUP_ID] },
        context: asUser,
      }),
    ).rejects.toThrow("insert violates policy");
  });
});

describe("addContactsToGroups", () => {
  it("upserts the full cross-product with user_id pinned from the context", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: GROUP_ID, user_id: TEST_USER }),
      makeGroupRow({ id: PARENT_ID, user_id: TEST_USER }),
    ]);
    const res = (await call(addContactsToGroups, {
      data: { groupIds: [GROUP_ID, PARENT_ID], contactIds: [CONTACT_ID] },
      context: asUser,
    })) as unknown as { added: number };
    expect(res).toEqual({ added: 2 });
    expect(rls.calls.upserts[0]!.payload).toStrictEqual([
      { group_id: GROUP_ID, contact_id: CONTACT_ID, user_id: TEST_USER },
      { group_id: PARENT_ID, contact_id: CONTACT_ID, user_id: TEST_USER },
    ]);
  });

  it("refuses when any target group is auto-generated, writing nothing", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: GROUP_ID, user_id: TEST_USER }),
      makeGroupRow({ id: PARENT_ID, user_id: TEST_USER, auto_generated_from_group_id: GROUP_ID }),
    ]);
    await expect(
      call(addContactsToGroups, {
        data: { groupIds: [GROUP_ID, PARENT_ID], contactIds: [CONTACT_ID] },
        context: asUser,
      }),
    ).rejects.toThrow("managed automatically");
    expect(writeCount(rls)).toBe(0);
  });

  it("zod rejects an empty selection on either side", async () => {
    await expect(
      addContactsToGroups({ data: { groupIds: [], contactIds: [CONTACT_ID] } }),
    ).rejects.toThrow();
    await expect(
      addContactsToGroups({ data: { groupIds: [GROUP_ID], contactIds: [] } }),
    ).rejects.toThrow();
    expect(writeCount(rls)).toBe(0);
  });
});

describe("listContactGroups", () => {
  it("returns member counts, the linked folder and the label's companies", async () => {
    rls.seed("contact_groups", [
      makeGroupRow({ id: GROUP_ID, user_id: TEST_USER, name: "Clients", folder_id: FOLDER_ID }),
    ]);
    rls.seed("contact_group_members", [
      makeGroupMemberRow({ group_id: GROUP_ID, contact_id: CONTACT_ID, user_id: TEST_USER }),
      makeGroupMemberRow({ group_id: GROUP_ID, contact_id: "c2", user_id: TEST_USER }),
    ]);
    rls.seed("folders", [{ id: FOLDER_ID, user_id: TEST_USER, name: "Clients", color: "#123456" }]);
    rls.seed("contact_group_rules", [
      {
        id: "r1",
        user_id: TEST_USER,
        group_id: GROUP_ID,
        rule_type: "company_id",
        value: "co-1",
        auto_apply: true,
      },
    ]);
    rls.seed("companies", [{ id: "co-1", user_id: TEST_USER, name: "Acme" }]);

    const res = (await call(listContactGroups, { data: {}, context: asUser })) as unknown as {
      groups: Array<{ id: string; count: number; linked_folder: unknown; companies: unknown }>;
    };
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]).toMatchObject({
      id: GROUP_ID,
      count: 2,
      linked_folder: { name: "Clients", color: "#123456" },
      companies: [{ id: "co-1", name: "Acme" }],
    });
  });

  it("a suggest-only company rule contributes no company chip", async () => {
    rls.seed("contact_groups", [makeGroupRow({ id: GROUP_ID, user_id: TEST_USER })]);
    rls.seed("contact_group_rules", [
      {
        id: "r1",
        user_id: TEST_USER,
        group_id: GROUP_ID,
        rule_type: "company_id",
        value: "co-1",
        auto_apply: false,
      },
    ]);
    rls.seed("companies", [{ id: "co-1", user_id: TEST_USER, name: "Acme" }]);
    const res = (await call(listContactGroups, { data: {}, context: asUser })) as unknown as {
      groups: Array<{ companies: unknown[] }>;
    };
    expect(res.groups[0]!.companies).toStrictEqual([]);
  });

  it("a failing groups read surfaces to the caller", async () => {
    rls.onSelect("contact_groups", () => ({ message: "statement timeout" }));
    await expect(call(listContactGroups, { data: {}, context: asUser })).rejects.toThrow(
      "statement timeout",
    );
  });
});
