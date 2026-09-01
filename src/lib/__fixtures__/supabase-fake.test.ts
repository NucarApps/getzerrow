// Pins the semantics of the shared Supabase fake itself. Every other DB
// test leans on these behaviours, so a regression here would silently
// weaken hundreds of assertions — in particular the filters that used to
// be pass-throughs (ilike / contains / or) and made "never matches a
// same-named group" style tests unfalsifiable.

import { describe, it, expect } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, PGRST_NO_ROWS } from "./supabase-fake";

const T = "contact_groups" as const;

function fakeWith(rows: Array<Record<string, unknown>>) {
  const fake = makeSupabaseFake();
  fake.seedRaw(T, rows);
  return fake;
}

describe("select filters", () => {
  const rows = [
    { id: "1", name: "Acme Corp", user_id: "u1", color: null, tags: ["a", "b"] },
    { id: "2", name: "acme corp", user_id: "u2", color: "#fff", tags: ["a"] },
    { id: "3", name: "Other", user_id: "u1", color: null, tags: [] },
  ];

  it("ilike is a case-insensitive SQL LIKE (% and _ wildcards, literal otherwise)", async () => {
    const fake = fakeWith(rows);
    const { data } = await fake.supabaseAdmin.from(T).select("id").ilike("name", "acme%");
    expect(data?.map((r) => r.id)).toEqual(["1", "2"]);
    const dot = await fake.supabaseAdmin.from(T).select("id").ilike("name", "acme.corp");
    expect(dot.data).toEqual([]);
    const underscore = await fake.supabaseAdmin.from(T).select("id").ilike("name", "acme_corp");
    expect(underscore.data?.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("like is case-sensitive", async () => {
    const fake = fakeWith(rows);
    const { data } = await fake.supabaseAdmin.from(T).select("id").like("name", "acme%");
    expect(data?.map((r) => r.id)).toEqual(["2"]);
  });

  it("contains on an array column is superset", async () => {
    const fake = fakeWith(rows);
    const { data } = await fake.supabaseAdmin.from(T).select("id").contains("tags", ["a"]);
    expect(data?.map((r) => r.id)).toEqual(["1", "2"]);
    const both = await fake.supabaseAdmin.from(T).select("id").contains("tags", ["a", "b"]);
    expect(both.data?.map((r) => r.id)).toEqual(["1"]);
  });

  it("or parses PostgREST syntax incl. is.null, in.(), and nested and()", async () => {
    const fake = fakeWith(rows);
    const { data } = await fake.supabaseAdmin
      .from(T)
      .select("id")
      .or("color.is.null,user_id.eq.u2");
    expect(data?.map((r) => r.id)).toEqual(["1", "2", "3"]);
    const nested = await fake.supabaseAdmin
      .from(T)
      .select("id")
      .or("id.in.(2,3),and(user_id.eq.u1,name.ilike.acme%)");
    expect(nested.data?.map((r) => r.id)).toEqual(["1", "2", "3"]);
    const narrow = await fake.supabaseAdmin
      .from(T)
      .select("id")
      .or("and(user_id.eq.u1,color.not.is.null)");
    expect(narrow.data).toEqual([]);
  });

  it("not(col, op, value) negates the inner op", async () => {
    const fake = fakeWith(rows);
    const { data } = await fake.supabaseAdmin.from(T).select("id").not("color", "is", null);
    expect(data?.map((r) => r.id)).toEqual(["2"]);
    const notIn = await fake.supabaseAdmin.from(T).select("id").not("id", "in", ["1", "2"]);
    expect(notIn.data?.map((r) => r.id)).toEqual(["3"]);
  });

  it("range honours the offset, not just the size", async () => {
    const fake = fakeWith(rows);
    const { data } = await fake.supabaseAdmin.from(T).select("id").order("id").range(1, 2);
    expect(data?.map((r) => r.id)).toEqual(["2", "3"]);
  });

  it("single() on zero rows returns the PostgREST no-rows code", async () => {
    const fake = fakeWith(rows);
    const { data, error } = await fake.supabaseAdmin.from(T).select().eq("id", "nope").single();
    expect(data).toBeNull();
    expect(error?.code).toBe(PGRST_NO_ROWS);
  });

  it("count option reports the pre-limit total; head returns no rows", async () => {
    const fake = fakeWith(rows);
    const { data, count } = await fake.supabaseAdmin
      .from(T)
      .select("id", { count: "exact", head: true })
      .eq("user_id", "u1");
    expect(data).toBeNull();
    expect(count).toBe(2);
  });

  it("onSelect can fail a read", async () => {
    const fake = fakeWith(rows);
    fake.onSelect(T, () => ({ message: "boom" }));
    const { data, error } = await fake.supabaseAdmin.from(T).select();
    expect(data).toBeNull();
    expect(error?.message).toBe("boom");
    await expect(fake.supabaseAdmin.from(T).select().single()).resolves.toMatchObject({
      error: { message: "boom" },
    });
  });

  it("strict mode throws on an unimplemented modifier instead of returning everything", async () => {
    const fake = makeSupabaseFake({ strict: true });
    fake.seedRaw(T, rows);
    await expect(fake.supabaseAdmin.from(T).select().filter("name", "fts", "acme")).rejects.toThrow(
      /unimplemented filter "fts"/,
    );
  });
});

describe("writes", () => {
  it("record only by default: update().select() resolves the would-be rows, seeds untouched", async () => {
    const fake = fakeWith([{ id: "1", name: "a", user_id: "u1" }]);
    const res = await fake.supabaseAdmin
      .from(T)
      .update({ name: "b" })
      .eq("user_id", "u1")
      .select("id");
    expect(res.data).toEqual([{ id: "1", name: "b", user_id: "u1" }]);
    expect(res.count).toBe(1);
    expect(fake.rows(T)[0]?.name).toBe("a");
    expect(fake.calls.updates).toHaveLength(1);
  });

  it("update/delete report count = matching seeded rows", async () => {
    const fake = fakeWith([
      { id: "1", user_id: "u1" },
      { id: "2", user_id: "u1" },
      { id: "3", user_id: "u2" },
    ]);
    const upd = await fake.supabaseAdmin.from(T).update({ name: "x" }).eq("user_id", "u1");
    expect(upd.count).toBe(2);
    const del = await fake.supabaseAdmin.from(T).delete().eq("user_id", "u2");
    expect(del.count).toBe(1);
  });

  it("applyWrites: insert appends, update patches, delete removes, upsert merges on onConflict", async () => {
    const fake = makeSupabaseFake({ applyWrites: true });
    fake.seedRaw(T, [{ id: "1", name: "a", user_id: "u1" }]);
    await fake.supabaseAdmin.from(T).insert({ id: "2", name: "b", user_id: "u1" });
    await fake.supabaseAdmin.from(T).update({ name: "A" }).eq("id", "1");
    await fake.supabaseAdmin.from(T).upsert([
      { id: "2", name: "B", user_id: "u1" },
      { id: "3", name: "c", user_id: "u1" },
    ]);
    await fake.supabaseAdmin.from(T).delete().eq("id", "3");
    expect(fake.rows(T)).toEqual([
      { id: "1", name: "A", user_id: "u1" },
      { id: "2", name: "B", user_id: "u1" },
    ]);
    const byKey = makeSupabaseFake({ applyWrites: true });
    byKey.seedRaw(T, [{ user_id: "u1", name: "k", color: "red" }]);
    await byKey.supabaseAdmin
      .from(T)
      .upsert({ user_id: "u1", name: "k", color: "blue" }, { onConflict: "user_id,name" });
    expect(byKey.rows(T)).toEqual([{ user_id: "u1", name: "k", color: "blue" }]);
  });

  it("a write handler can fail the write or inject returned rows", async () => {
    const fake = fakeWith([]);
    fake.onInsert(T, () => ({ message: "dup", code: "23505" }));
    const failed = await fake.supabaseAdmin.from(T).insert({ name: "x" }).select().single();
    expect(failed.error?.code).toBe("23505");
    fake.onInsert(T, () => ({ data: { id: "generated" } }));
    const ok = await fake.supabaseAdmin.from(T).insert({ name: "x" }).select("id").single();
    expect(ok.data).toEqual({ id: "generated" });
  });

  it("write filters share the read filter set (neq/ilike/or on update)", async () => {
    const fake = makeSupabaseFake({ applyWrites: true });
    fake.seedRaw(T, [
      { id: "1", name: "Acme", user_id: "u1" },
      { id: "2", name: "acme inc", user_id: "u1" },
      { id: "3", name: "Zed", user_id: "u1" },
    ]);
    await fake.supabaseAdmin.from(T).update({ name: "hit" }).ilike("name", "acme%").neq("id", "2");
    expect(fake.rows(T).map((r) => r.name)).toEqual(["hit", "acme inc", "Zed"]);
  });
});

describe("auth.admin and the hoist-safe mock", () => {
  it("dispatches to onAuth handlers and records calls", async () => {
    const fake = makeSupabaseFake();
    fake.onAuth("deleteUser", (id) => ({ data: { id }, error: null }));
    const r = await fake.supabaseAdmin.auth.admin.deleteUser("u1");
    expect(r).toEqual({ data: { id: "u1" }, error: null });
    expect(fake.calls.auth).toEqual([{ method: "deleteUser", args: "u1" }]);
  });

  it("mockSupabaseAdmin forwards lazily so it can live inside a hoisted vi.mock factory", async () => {
    const holder: { fake?: ReturnType<typeof makeSupabaseFake> } = {};
    const admin = mockSupabaseAdmin(() => holder.fake!);
    holder.fake = fakeWith([{ id: "1" }]);
    const fake = holder.fake;
    const { data } = await admin.from(T).select("id");
    expect(data).toEqual([{ id: "1" }]);
    await admin.rpc("cron_secret_matches", { p_secret: "x" });
    expect(fake.calls.rpcs).toEqual([{ fn: "cron_secret_matches", args: { p_secret: "x" } }]);
  });
});
