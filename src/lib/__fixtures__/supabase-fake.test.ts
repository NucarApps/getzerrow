// Pins the semantics of the shared Supabase fake itself. Every other DB
// test leans on these behaviours, so a regression here would silently
// weaken hundreds of assertions — in particular the filters that used to
// be pass-throughs (ilike / contains / or) and made "never matches a
// same-named group" style tests unfalsifiable.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
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

describe("storage", () => {
  it("records every call and lets a test drive the signed-url and download paths", async () => {
    const fake = makeSupabaseFake();
    fake.onStorage("cards", "createSignedUrl", (key) => ({
      data: { signedUrl: `https://signed.test/${key}` },
    }));
    const signed = await fake.supabaseAdmin.storage.from("cards").createSignedUrl("u/1.png", 600);
    expect(signed).toEqual({ data: { signedUrl: "https://signed.test/u/1.png" }, error: null });

    fake.onStorage("cards", "download", () => ({ error: { message: "gone" } }));
    expect(await fake.supabaseAdmin.storage.from("cards").download("u/1.png")).toEqual({
      data: null,
      error: { message: "gone" },
    });

    // Unstubbed methods still resolve and are still recorded.
    await fake.supabaseAdmin.storage.from("cards").remove(["u/1.png"]);
    expect(fake.calls.storage).toEqual([
      { bucket: "cards", method: "createSignedUrl", args: ["u/1.png", 600] },
      { bucket: "cards", method: "download", args: ["u/1.png"] },
      { bucket: "cards", method: "remove", args: [["u/1.png"]] },
    ]);
  });

  it("getPublicUrl is synchronous and has a usable default", () => {
    const fake = makeSupabaseFake();
    expect(fake.supabaseAdmin.storage.from("logos").getPublicUrl("a/b.png")).toEqual({
      data: { publicUrl: "https://storage.test/logos/a/b.png" },
    });
  });
});

describe("PostgREST embeds", () => {
  it("resolves a registered embed instead of leaving the join undefined", async () => {
    const fake = makeSupabaseFake();
    fake.seedRaw("contact_group_members", [
      { group_id: "g1", contact_id: "c1" },
      { group_id: "g1", contact_id: "c2" },
    ]);
    fake.seedRaw("contacts", [
      { id: "c1", company: "Acme" },
      { id: "c2", company: "Globex" },
    ]);
    fake.onEmbed("contact_group_members", "contacts", { table: "contacts" });

    const { data } = await fake.supabaseAdmin
      .from("contact_group_members")
      .select("contact_id, contacts:contacts(id, company)")
      .eq("group_id", "g1");
    expect(data?.map((r) => (r.contacts as { company: string }).company)).toEqual([
      "Acme",
      "Globex",
    ]);
  });

  it("leaves an unregistered embed alone rather than inventing rows", async () => {
    const fake = makeSupabaseFake();
    fake.seedRaw("contact_group_members", [{ group_id: "g1", contact_id: "c1" }]);
    const { data } = await fake.supabaseAdmin
      .from("contact_group_members")
      .select("contact_id, contacts:contacts(id)");
    expect(data?.[0]).not.toHaveProperty("contacts");
  });
});

describe("filter-string quirks", () => {
  it("treats * as the LIKE wildcard inside an or() term (PostgREST string form)", async () => {
    const fake = makeSupabaseFake();
    fake.seedRaw("emails", [
      { id: "1", from_addr: "a@acme.com" },
      { id: "2", from_addr: "b@other.com" },
    ]);
    const { data } = await fake.supabaseAdmin
      .from("emails")
      .select("id")
      .or("from_addr.ilike.*@acme.com");
    expect(data?.map((r) => r.id)).toEqual(["1"]);
  });

  it("records the options object passed to insert/update/delete", async () => {
    const fake = makeSupabaseFake();
    await fake.supabaseAdmin
      .from("emails")
      .update({ is_read: true }, { count: "exact" })
      .eq("id", "1");
    expect(fake.calls.updates[0]!.options).toEqual({ count: "exact" });
  });
});

describe("embeds and query metadata", () => {
  it("resolves the bare table(cols) and table!inner(cols) embed spellings", async () => {
    const fake = makeSupabaseFake();
    fake.seedRaw("contact_group_members", [{ group_id: "g1", contact_id: "c1" }]);
    fake.seedRaw("contacts", [{ id: "c1", email: "a@x.com", user_id: "u1" }]);
    fake.onEmbed("contact_group_members", "contacts", { table: "contacts" });

    // `contacts!inner(...)` — the spelling account-context.ts actually uses.
    const inner = await fake.supabaseAdmin
      .from("contact_group_members")
      .select("group_id,contacts!inner(email,user_id)");
    expect((inner.data?.[0] as { contacts: { email: string } }).contacts.email).toBe("a@x.com");

    // `contacts(...)` with no alias and no modifier.
    const bare = await fake.supabaseAdmin
      .from("contact_group_members")
      .select("group_id,contacts(email)");
    expect((bare.data?.[0] as { contacts: { email: string } }).contacts.email).toBe("a@x.com");
  });

  it("records limit and range on the select without disturbing the filter list", async () => {
    const fake = makeSupabaseFake();
    fake.seedRaw("emails", [{ id: "1", user_id: "u1" }]);
    await fake.supabaseAdmin.from("emails").select("id").eq("user_id", "u1").limit(25);
    await fake.supabaseAdmin.from("emails").select("id").range(10, 19);
    expect(fake.calls.selects[0]).toMatchObject({
      limit: 25,
      filters: [{ op: "eq", col: "user_id", value: "u1" }],
    });
    expect(fake.calls.selects[1]).toMatchObject({ range: [10, 19], filters: [] });
  });
});

describe("column projection", () => {
  it("returns the whole seeded row by default", async () => {
    const fake = makeSupabaseFake();
    fake.seedRaw("emails", [{ id: "1", user_id: "u1", subject: "hi", body_text: "secret" }]);
    const { data } = await fake.supabaseAdmin.from("emails").select("id, subject");
    // The default is deliberately loose: suites written against it seed
    // whole rows and read fields the query never named.
    expect(data?.[0]).toHaveProperty("body_text", "secret");
  });

  it("narrows a read to the columns the select named", async () => {
    const fake = makeSupabaseFake({ projectColumns: true });
    fake.seedRaw("emails", [{ id: "1", user_id: "u1", subject: "hi", body_text: "secret" }]);
    const { data } = await fake.supabaseAdmin.from("emails").select("id, subject");
    expect(data?.[0]).toEqual({ id: "1", subject: "hi" });
  });

  it("keeps every column for `*` and for an absent select", async () => {
    const fake = makeSupabaseFake({ projectColumns: true });
    fake.seedRaw("emails", [{ id: "1", user_id: "u1", subject: "hi" }]);
    const star = await fake.supabaseAdmin.from("emails").select("*");
    expect(star.data?.[0]).toEqual({ id: "1", user_id: "u1", subject: "hi" });
    const mixed = await fake.supabaseAdmin.from("emails").select("*, id");
    expect(mixed.data?.[0]).toHaveProperty("user_id", "u1");
  });

  it("keeps a renamed column under its source name and keeps embeds", async () => {
    const fake = makeSupabaseFake({ projectColumns: true });
    fake.seedRaw("contact_group_members", [{ group_id: "g1", contact_id: "c1", added_by: "u1" }]);
    fake.seedRaw("contacts", [{ id: "c1", company: "Acme" }]);
    fake.onEmbed("contact_group_members", "contacts", { table: "contacts" });

    const { data } = await fake.supabaseAdmin
      .from("contact_group_members")
      .select("cid:contact_id, contacts:contacts(company)");
    expect(data?.[0]).toEqual({ contact_id: "c1", contacts: { id: "c1", company: "Acme" } });
  });

  it("narrows the rows a returning write resolves", async () => {
    const fake = makeSupabaseFake({ projectColumns: true, applyWrites: true });
    const { data } = await fake.supabaseAdmin
      .from("emails")
      .insert({ id: "1", user_id: "u1", subject: "hi" })
      .select("id")
      .single();
    expect(data).toEqual({ id: "1" });
  });
});

describe("rlsScope", () => {
  it("hides another user's rows from every read of that table", async () => {
    const fake = makeSupabaseFake();
    fake.seedRaw("contacts", [
      { id: "mine", user_id: "u1" },
      { id: "theirs", user_id: "u2" },
    ]);
    fake.rlsScope("contacts", "u1");

    // A handler that leans on RLS adds no user_id filter of its own.
    const all = await fake.supabaseAdmin.from("contacts").select("*");
    expect(all.data?.map((r) => r.id)).toEqual(["mine"]);

    const byId = await fake.supabaseAdmin
      .from("contacts")
      .select("*")
      .eq("id", "theirs")
      .maybeSingle();
    expect(byId.data).toBeNull();
  });

  it("leaves other tables alone", async () => {
    const fake = makeSupabaseFake();
    fake.seedRaw("contacts", [{ id: "c", user_id: "u2" }]);
    fake.seedRaw("companies", [{ id: "co", user_id: "u2" }]);
    fake.rlsScope("contacts", "u1");
    const companies = await fake.supabaseAdmin.from("companies").select("*");
    expect(companies.data).toHaveLength(1);
  });
});

describe("catalog relations", () => {
  it("seeds and reads a relation outside the public schema", async () => {
    // The health check reads pg_views / information_schema.columns
    // directly; those are not in the generated Database type.
    const fake = makeSupabaseFake();
    fake.seedRaw("pg_views", [{ viewname: "email_search_index" }]);
    fake.onSelect("information_schema.columns", () => ({
      data: [{ table_name: "emails", column_name: "origin_addr" }],
    }));

    const views = await fake.supabaseAdmin.from("pg_views").select("viewname");
    expect(views.data).toEqual([{ viewname: "email_search_index" }]);

    const cols = await fake.supabaseAdmin.from("information_schema.columns").select("*");
    expect(cols.data?.[0]).toMatchObject({ column_name: "origin_addr" });
  });

  it("exposes raw rows for a relation `rows` cannot type", async () => {
    const fake = makeSupabaseFake();
    fake.seedRaw("pg_proc", [{ proname: "search_emails" }]);
    expect(fake.rowsRaw("pg_proc")).toEqual([{ proname: "search_emails" }]);
  });
});

describe("asClient", () => {
  it("hands the fake to code that takes a SupabaseClient parameter", async () => {
    const fake = makeSupabaseFake();
    fake.seedRaw("contacts", [{ id: "c1", user_id: "u1" }]);

    // Shape of the real call sites: a plain function given a client.
    async function countContacts(client: SupabaseClient<Database>, userId: string) {
      const { data } = await client.from("contacts").select("id").eq("user_id", userId);
      return data?.length ?? 0;
    }

    expect(await countContacts(fake.asClient(), "u1")).toBe(1);
  });
});

describe("browser auth surface", () => {
  it("answers signed-out in the real client's shape, not a bare null", async () => {
    // Components destructure `data.user` unconditionally; a bare null
    // would throw where the real client returns the signed-out branch.
    const fake = makeSupabaseFake();
    expect(await fake.supabaseAdmin.auth.getUser()).toEqual({
      data: { user: null },
      error: null,
    });
    expect(await fake.supabaseAdmin.auth.getSession()).toEqual({
      data: { session: null },
      error: null,
    });
  });

  it("signedInAs answers as that user, and null goes back to signed out", async () => {
    const fake = makeSupabaseFake();
    fake.signedInAs("user-1");

    const { data } = await fake.supabaseAdmin.auth.getUser();
    expect((data as { user: { id: string } }).user.id).toBe("user-1");
    const session = await fake.supabaseAdmin.auth.getSession();
    expect((session.data as { session: { user: { id: string } } }).session.user.id).toBe("user-1");

    fake.signedInAs(null);
    expect((await fake.supabaseAdmin.auth.getUser()).data).toEqual({ user: null });
  });

  it("records the browser auth reads alongside the admin ones", async () => {
    const fake = makeSupabaseFake();
    await fake.supabaseAdmin.auth.getUser();
    await fake.supabaseAdmin.auth.admin.listUsers();
    expect(fake.calls.auth.map((c) => c.method)).toEqual(["getUser", "listUsers"]);
  });
});
