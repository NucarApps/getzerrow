// Shared resolve-or-create for company labels (label-resolve.server.ts).
// Every label-create path in the app routes through this function, which
// is the only thing stopping "Nissan", "Nissan, Inc." and a merged-away
// "Nissan Motor Acceptance Company" from minting three contact_groups
// rows. The name-matching itself is pure and covered in
// label-resolve.test.ts; what is pinned here is the resolution ORDER and
// the DB effects, both of which a refactor can reorder invisibly:
//
//   1. the company's linked label wins, but only when it lives in the
//      requested parent scope,
//   2. otherwise a key match among labels already in that scope,
//   3. otherwise an insert — and on a unique-index race, a re-select
//      rather than a thrown error, first by scoped key match (the winner's
//      spelling may differ) and then by byte-name across scopes (the
//      legacy global index),
//
// plus: companies.linked_group_id is back-filled only when it is still
// null (never stolen from an existing link), every read and write carries
// a user_id predicate, and the per-run cache is keyed by parent scope so
// a batch import cannot leak a child label into the root scope.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveOrCreateCompanyLabel,
  loadNameAliasMap,
  newGroupCardDavUid,
  type LabelResolveCache,
} from "./label-resolve.server";

const fake = makeSupabaseFake({ applyWrites: true });

const USER = "user-1";
const ctx = { supabase: fake.supabaseAdmin as unknown as SupabaseClient, userId: USER };

/** The insert path needs a DB-assigned id, which the fake does not mint. */
function insertReturns(id: string) {
  fake.onInsert("contact_groups", (payload) => ({
    data: { id, name: (payload as { name: string }).name },
  }));
}

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  insertReturns("new-group");
});

describe("newGroupCardDavUid", () => {
  it("mints a prefixed, unique uid", () => {
    const a = newGroupCardDavUid();
    expect(a).toMatch(/^group-/);
    expect(a).not.toBe(newGroupCardDavUid());
  });
});

describe("loadNameAliasMap", () => {
  it("maps a merged-away name key to the canonical company name", async () => {
    fake.seedRaw("company_name_aliases", [
      { user_id: USER, name_key: "nissanmotoracceptance", companies: { name: "Nissan" } },
    ]);
    const map = await loadNameAliasMap(ctx);
    expect(map.get("nissanmotoracceptance")).toBe("Nissan");
    expect(fake.calls.selects[0]).toMatchObject({
      table: "company_name_aliases",
      filters: [{ op: "eq", col: "user_id", value: USER }],
    });
  });

  it("accepts the join as an array, which is how the generated types shape it", async () => {
    fake.seedRaw("company_name_aliases", [
      { user_id: USER, name_key: "acme", companies: [{ name: "Acme" }] },
    ]);
    expect((await loadNameAliasMap(ctx)).get("acme")).toBe("Acme");
  });

  it("drops rows with no key or no company rather than mapping to undefined", async () => {
    fake.seedRaw("company_name_aliases", [
      { user_id: USER, name_key: null, companies: { name: "Acme" } },
      { user_id: USER, name_key: "orphan", companies: null },
    ]);
    expect((await loadNameAliasMap(ctx)).size).toBe(0);
  });
});

describe("resolveOrCreateCompanyLabel input handling", () => {
  it("returns null for a blank name without touching the DB", async () => {
    expect(await resolveOrCreateCompanyLabel(ctx, { rawName: "   " })).toBeNull();
    expect(fake.calls.selects).toEqual([]);
    expect(fake.calls.inserts).toEqual([]);
  });

  it("trims the stored name", async () => {
    await resolveOrCreateCompanyLabel(ctx, { rawName: "  Acme  " });
    expect(fake.calls.inserts[0]?.payload).toMatchObject({ name: "Acme" });
  });
});

describe("resolveOrCreateCompanyLabel resolution order", () => {
  it("prefers the company's linked label when it is in the requested scope", async () => {
    fake.seedRaw("companies", [{ id: "co-1", user_id: USER, linked_group_id: "g-linked" }]);
    fake.seedRaw("contact_groups", [
      { id: "g-linked", user_id: USER, name: "Nissan Motors", parent_group_id: null },
      { id: "g-key", user_id: USER, name: "Nissan", parent_group_id: null },
    ]);

    const res = await resolveOrCreateCompanyLabel(ctx, { rawName: "Nissan", companyId: "co-1" });

    // The linked label wins even though a closer name match exists.
    expect(res).toEqual({ id: "g-linked", name: "Nissan Motors", created: false });
    expect(fake.calls.inserts).toEqual([]);
  });

  it("ignores a linked label that lives in a different parent scope", async () => {
    fake.seedRaw("companies", [{ id: "co-1", user_id: USER, linked_group_id: "g-root" }]);
    fake.seedRaw("contact_groups", [
      { id: "g-root", user_id: USER, name: "Acme", parent_group_id: null },
      { id: "g-child", user_id: USER, name: "Acme", parent_group_id: "p-1" },
    ]);

    const res = await resolveOrCreateCompanyLabel(ctx, {
      rawName: "Acme",
      companyId: "co-1",
      parentGroupId: "p-1",
    });

    expect(res).toMatchObject({ id: "g-child", created: false });
  });

  it("falls back to a key match among labels already in scope", async () => {
    fake.seedRaw("contact_groups", [
      { id: "g-1", user_id: USER, name: "Nissan, Inc.", parent_group_id: null },
    ]);
    const res = await resolveOrCreateCompanyLabel(ctx, { rawName: "Nissan" });
    expect(res).toEqual({ id: "g-1", name: "Nissan, Inc.", created: false });
    expect(fake.calls.inserts).toEqual([]);
  });

  it("resolves a merged-away name through the alias map", async () => {
    fake.seedRaw("contact_groups", [
      { id: "g-1", user_id: USER, name: "Nissan", parent_group_id: null },
    ]);
    // The alias map is keyed by the MILD normalization of the raw name,
    // which keeps words the aggressive brand key strips ("Company" here) —
    // keying it by the brand key instead makes every alias a silent miss.
    const aliases = new Map([["nissan motor acceptance company", "Nissan"]]);
    const res = await resolveOrCreateCompanyLabel(ctx, {
      rawName: "Nissan Motor Acceptance Company",
      nameAliases: aliases,
    });
    expect(res).toMatchObject({ id: "g-1", created: false });
  });

  it("does not match a label from a different scope", async () => {
    fake.seedRaw("contact_groups", [
      { id: "g-root", user_id: USER, name: "Acme", parent_group_id: null },
    ]);
    const res = await resolveOrCreateCompanyLabel(ctx, { rawName: "Acme", parentGroupId: "p-1" });
    expect(res).toMatchObject({ created: true });
    expect(fake.calls.inserts[0]?.payload).toMatchObject({ parent_group_id: "p-1" });
  });

  it("does not match another user's label", async () => {
    fake.seedRaw("contact_groups", [
      { id: "g-theirs", user_id: "someone-else", name: "Acme", parent_group_id: null },
    ]);
    expect(await resolveOrCreateCompanyLabel(ctx, { rawName: "Acme" })).toMatchObject({
      created: true,
    });
  });
});

describe("resolveOrCreateCompanyLabel insert", () => {
  it("inserts under the caller with a carddav uid and the default colour", async () => {
    const res = await resolveOrCreateCompanyLabel(ctx, { rawName: "Acme" });

    expect(res).toEqual({ id: "new-group", name: "Acme", created: true });
    expect(fake.calls.inserts[0]?.payload).toMatchObject({
      user_id: USER,
      name: "Acme",
      color: "#6366f1",
      parent_group_id: null,
    });
    expect((fake.calls.inserts[0]?.payload as { carddav_uid: string }).carddav_uid).toMatch(
      /^group-/,
    );
  });

  it("honours an explicit colour and extra insert columns", async () => {
    await resolveOrCreateCompanyLabel(ctx, {
      rawName: "Acme",
      color: "#ff0000",
      extraInsert: { auto_generated_from_group_id: "parent-1" },
    });
    expect(fake.calls.inserts[0]?.payload).toMatchObject({
      color: "#ff0000",
      auto_generated_from_group_id: "parent-1",
    });
  });
});

describe("resolveOrCreateCompanyLabel unique-index race", () => {
  it("re-selects the scoped winner instead of failing", async () => {
    fake.onInsert("contact_groups", () => ({ message: "duplicate key" }));
    // The racing writer created the row under a different spelling; the
    // scoped key match is what finds it.
    fake.seedRaw("contact_groups", [
      { id: "g-winner", user_id: USER, name: "Acme, Inc.", parent_group_id: null },
    ]);

    const res = await resolveOrCreateCompanyLabel(ctx, { rawName: "Acme" });

    expect(res).toEqual({ id: "g-winner", name: "Acme, Inc.", created: false });
  });

  it("falls back to a byte-name lookup across scopes for the legacy global index", async () => {
    fake.onInsert("contact_groups", () => ({ message: "duplicate key" }));
    // Same name, different scope: the scoped key match cannot see it, but
    // the legacy (user_id, lower(name)) index is what rejected the insert.
    fake.seedRaw("contact_groups", [
      { id: "g-elsewhere", user_id: USER, name: "Acme", parent_group_id: "other-parent" },
    ]);

    const res = await resolveOrCreateCompanyLabel(ctx, { rawName: "Acme" });

    expect(res).toEqual({ id: "g-elsewhere", name: "Acme", created: false });
  });

  it("rethrows when the insert failed for a reason other than a race", async () => {
    fake.onInsert("contact_groups", () => ({ message: "column does not exist" }));
    await expect(resolveOrCreateCompanyLabel(ctx, { rawName: "Acme" })).rejects.toThrow(
      "column does not exist",
    );
  });
});

describe("resolveOrCreateCompanyLabel company back-fill", () => {
  it("links the company to the resolved label when it has no link yet", async () => {
    fake.seedRaw("companies", [{ id: "co-1", user_id: USER, linked_group_id: null }]);

    await resolveOrCreateCompanyLabel(ctx, { rawName: "Acme", companyId: "co-1" });

    expect(fake.calls.updates[0]).toMatchObject({
      table: "companies",
      payload: { linked_group_id: "new-group" },
      filters: [
        { op: "eq", col: "id", value: "co-1" },
        { op: "eq", col: "user_id", value: USER },
      ],
    });
  });

  it("never steals an existing link", async () => {
    fake.seedRaw("companies", [{ id: "co-1", user_id: USER, linked_group_id: "g-linked" }]);
    fake.seedRaw("contact_groups", [
      { id: "g-linked", user_id: USER, name: "Acme", parent_group_id: null },
    ]);

    await resolveOrCreateCompanyLabel(ctx, { rawName: "Acme", companyId: "co-1" });

    expect(fake.calls.updates).toEqual([]);
  });

  it("writes nothing when no companyId was supplied", async () => {
    await resolveOrCreateCompanyLabel(ctx, { rawName: "Acme" });
    expect(fake.calls.updates).toEqual([]);
  });
});

describe("resolveOrCreateCompanyLabel cache", () => {
  it("serves a repeat resolution without re-querying for the label", async () => {
    const cache: LabelResolveCache = new Map();
    // Aliases passed in, as a batch importer does — the cache is consulted
    // AFTER the alias map is resolved, so a caller that lets this function
    // load aliases itself still pays for that read on every call.
    const args = { rawName: "Acme", nameAliases: new Map<string, string>(), cache };
    const first = await resolveOrCreateCompanyLabel(ctx, args);
    const selectsAfterFirst = fake.calls.selects.length;

    const second = await resolveOrCreateCompanyLabel(ctx, args);

    expect(second).toEqual(first);
    expect(fake.calls.selects).toHaveLength(selectsAfterFirst);
    expect(fake.calls.inserts).toHaveLength(1);
  });

  it("keys the cache by parent scope so a child label cannot leak into the root", async () => {
    const cache: LabelResolveCache = new Map();
    await resolveOrCreateCompanyLabel(ctx, { rawName: "Acme", parentGroupId: "p-1", cache });
    insertReturns("root-group");

    const root = await resolveOrCreateCompanyLabel(ctx, { rawName: "Acme", cache });

    expect(root).toMatchObject({ id: "root-group", created: true });
    expect(fake.calls.inserts).toHaveLength(2);
  });

  it("caches variant spellings under the same key", async () => {
    const cache: LabelResolveCache = new Map();
    const first = await resolveOrCreateCompanyLabel(ctx, { rawName: "Acme", cache });
    const second = await resolveOrCreateCompanyLabel(ctx, { rawName: "Acme, Inc.", cache });
    expect(second).toEqual(first);
    expect(fake.calls.inserts).toHaveLength(1);
  });
});
