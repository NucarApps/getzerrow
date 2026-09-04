// Decrypted-email server fns (email-body.functions.ts). These are the only
// path by which plaintext bodies, summaries and search hits leave the
// server, so the contracts pinned here are ownership contracts first and
// shape contracts second:
//
//   * getEmailBody guards the decrypt-RPC result AFTER the fact —
//     getEmailsDecrypted runs on the service-role client with no user
//     predicate, so the `row.user_id !== userId` check in the handler is
//     the whole of the isolation. It returns `{ body: null, error:
//     "forbidden" }` rather than throwing, and must never leak a field of
//     the foreign row alongside it,
//   * getEmailListFields filters the caller's ids through an ownership
//     SELECT before decrypting, so an id the caller does not own is
//     dropped and never reaches the decrypt call at all,
//   * getInboxList and searchInbox take userId from the authenticated
//     context and never from the payload — pinned by asserting the
//     argument each collaborator was called with,
//   * searchInbox routes to the participant index only when a from/to
//     operator was parsed, and re-filters the metadata SELECT by user_id
//     because it runs on the admin client (which bypasses RLS).
//
// The zod contracts are pinned too: these fns take client-supplied ids and
// pagination, and a widened schema is a real regression.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

type Rows<T> = { rows: T[]; error?: string | null };
const getEmailsDecrypted = vi.fn(async (): Promise<Rows<Record<string, unknown>>> => ({
  rows: [],
}));
const getEmailListFieldsDecrypted = vi.fn(async (): Promise<Rows<Record<string, unknown>>> => ({
  rows: [],
}));
const getEmailsListDecrypted = vi.fn(
  async (_args: Record<string, unknown>): Promise<Rows<Record<string, unknown>>> => ({ rows: [] }),
);
const searchEmailsDecrypted = vi.fn(async (): Promise<Rows<Record<string, unknown>>> => ({
  rows: [],
}));
const searchEmailsParticipantsDecrypted = vi.fn(
  async (): Promise<Rows<Record<string, unknown>>> => ({ rows: [] }),
);
vi.mock("@/lib/sync/encrypted-reader", () => ({
  getEmailsDecrypted: (...a: unknown[]) => getEmailsDecrypted(...(a as [])),
  getEmailListFieldsDecrypted: (...a: unknown[]) => getEmailListFieldsDecrypted(...(a as [])),
  getEmailsListDecrypted: (...a: unknown[]) =>
    getEmailsListDecrypted(...(a as [Record<string, unknown>])),
  searchEmailsDecrypted: (...a: unknown[]) => searchEmailsDecrypted(...(a as [])),
  searchEmailsParticipantsDecrypted: (...a: unknown[]) =>
    searchEmailsParticipantsDecrypted(...(a as [])),
}));

const { getEmailBody, getEmailListFields, getInboxList, searchInbox } =
  await import("./email-body.functions");

const ATTACKER = "attacker-user";
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  getEmailsDecrypted.mockResolvedValue({ rows: [] });
  getEmailListFieldsDecrypted.mockResolvedValue({ rows: [] });
  getEmailsListDecrypted.mockResolvedValue({ rows: [] });
  searchEmailsDecrypted.mockResolvedValue({ rows: [] });
  searchEmailsParticipantsDecrypted.mockResolvedValue({ rows: [] });
});

describe("getEmailBody", () => {
  const body = {
    id: UUID_A,
    user_id: TEST_USER,
    body_text: "plain",
    body_html: "<p>plain</p>",
    ai_summary: "summary",
    classification_reason: "reason",
    // A column the fn must NOT forward — the decrypt RPC returns the whole
    // row, and widening the returned object would leak it to the client.
    forward_to: "ops@example.com",
  };

  it("returns exactly the five body fields for the owner", async () => {
    getEmailsDecrypted.mockResolvedValue({ rows: [body] });
    const res = await getEmailBody({ data: { email_id: UUID_A } });
    expect(res).toEqual({
      body: {
        id: UUID_A,
        body_text: "plain",
        body_html: "<p>plain</p>",
        ai_summary: "summary",
        classification_reason: "reason",
      },
      error: null,
    });
  });

  it("refuses a row owned by someone else and leaks nothing", async () => {
    getEmailsDecrypted.mockResolvedValue({ rows: [{ ...body, user_id: "victim-user" }] });
    const res = (await impersonate(getEmailBody, ATTACKER)({ data: { email_id: UUID_A } })) as {
      body: unknown;
      error: string | null;
    };
    expect(res).toEqual({ body: null, error: "forbidden" });
    expect(JSON.stringify(res)).not.toContain("plain");
    expect(writeCount(fake)).toBe(0);
  });

  it("reports not_found for an id the decrypt RPC returned nothing for", async () => {
    getEmailsDecrypted.mockResolvedValue({ rows: [] });
    expect(await getEmailBody({ data: { email_id: UUID_A } })).toEqual({
      body: null,
      error: "not_found",
    });
  });

  it("surfaces a decrypt error instead of a body", async () => {
    getEmailsDecrypted.mockResolvedValue({ rows: [], error: "decrypt failed" });
    expect(await getEmailBody({ data: { email_id: UUID_A } })).toEqual({
      body: null,
      error: "decrypt failed",
    });
  });

  it("rejects a non-uuid email_id before any work", async () => {
    await expect(getEmailBody({ data: { email_id: "not-a-uuid" } })).rejects.toThrow();
    expect(getEmailsDecrypted).not.toHaveBeenCalled();
  });
});

describe("getEmailListFields", () => {
  it("short-circuits an empty id list without touching the DB", async () => {
    expect(await getEmailListFields({ data: { ids: [] } })).toEqual({ fields: [], error: null });
    expect(fake.calls.selects).toEqual([]);
    expect(getEmailListFieldsDecrypted).not.toHaveBeenCalled();
  });

  it("decrypts only the ids the caller owns", async () => {
    // Both ids are asked for; only UUID_A belongs to the caller.
    fake.seedRaw("emails", [
      { id: UUID_A, user_id: TEST_USER },
      { id: UUID_B, user_id: "victim-user" },
    ]);
    getEmailListFieldsDecrypted.mockResolvedValue({ rows: [{ id: UUID_A, ai_summary: "s" }] });

    const res = await getEmailListFields({ data: { ids: [UUID_A, UUID_B] } });

    expect(getEmailListFieldsDecrypted).toHaveBeenCalledWith([UUID_A]);
    expect(res).toEqual({ fields: [{ id: UUID_A, ai_summary: "s" }], error: null });
    expect(fake.calls.selects[0]).toMatchObject({
      table: "emails",
      filters: [
        { op: "eq", col: "user_id", value: TEST_USER },
        { op: "in", col: "id", value: [UUID_A, UUID_B] },
      ],
    });
  });

  it("never decrypts when the caller owns none of the ids", async () => {
    fake.seedRaw("emails", [{ id: UUID_B, user_id: "victim-user" }]);
    const res = await impersonate(getEmailListFields, ATTACKER)({ data: { ids: [UUID_B] } });
    expect(res).toEqual({ fields: [], error: null });
    expect(getEmailListFieldsDecrypted).not.toHaveBeenCalled();
  });

  it("surfaces the ownership-select error rather than decrypting anyway", async () => {
    fake.onSelect("emails", () => ({ message: "boom" }));
    expect(await getEmailListFields({ data: { ids: [UUID_A] } })).toEqual({
      fields: [],
      error: "boom",
    });
    expect(getEmailListFieldsDecrypted).not.toHaveBeenCalled();
  });

  it("surfaces a decrypt error", async () => {
    fake.seedRaw("emails", [{ id: UUID_A, user_id: TEST_USER }]);
    getEmailListFieldsDecrypted.mockResolvedValue({ rows: [], error: "no key" });
    expect(await getEmailListFields({ data: { ids: [UUID_A] } })).toEqual({
      fields: [],
      error: "no key",
    });
  });

  it("caps the batch at 5000 ids", async () => {
    const ids = Array.from({ length: 5001 }, () => UUID_A);
    await expect(getEmailListFields({ data: { ids } })).rejects.toThrow();
  });
});

describe("getInboxList", () => {
  const base = { account_id: ACCOUNT, scope: "all" as const };

  it("passes the authenticated user id, never one from the payload", async () => {
    // A caller-supplied user_id must be dropped by the validator.
    await impersonate(getInboxList, ATTACKER)({ data: { ...base, user_id: "victim-user" } });
    expect(getEmailsListDecrypted).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ATTACKER }),
    );
    expect(getEmailsListDecrypted.mock.calls[0]?.[0]).not.toHaveProperty("user_id");
  });

  it("defaults cursor to null and limit to 51", async () => {
    await getInboxList({ data: base });
    expect(getEmailsListDecrypted).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      userId: TEST_USER,
      scope: "all",
      folderId: null,
      cursor: null,
      limit: 51,
    });
  });

  it("forwards folder_id only for the folder scope", async () => {
    await getInboxList({ data: { ...base, scope: "folder", folder_id: UUID_A } });
    expect(getEmailsListDecrypted.mock.calls[0]?.[0]).toMatchObject({ folderId: UUID_A });

    // The same folder_id under a non-folder scope must be ignored rather
    // than silently narrowing an "all" query.
    vi.clearAllMocks();
    getEmailsListDecrypted.mockResolvedValue({ rows: [] });
    await getInboxList({ data: { ...base, scope: "all_mail", folder_id: UUID_A } });
    expect(getEmailsListDecrypted.mock.calls[0]?.[0]).toMatchObject({ folderId: null });
  });

  it("returns an empty list on a decrypt error", async () => {
    getEmailsListDecrypted.mockResolvedValue({ rows: [], error: "rpc down" });
    expect(await getInboxList({ data: base })).toEqual({ rows: [], error: "rpc down" });
  });

  it("rejects an unknown scope and an out-of-range limit", async () => {
    await expect(getInboxList({ data: { ...base, scope: "everything" } })).rejects.toThrow();
    await expect(getInboxList({ data: { ...base, limit: 501 } })).rejects.toThrow();
    await expect(getInboxList({ data: { ...base, limit: 0 } })).rejects.toThrow();
  });
});

describe("searchInbox", () => {
  const hit = { id: UUID_A, subject: "Subject", snippet: "Snip", from_name: "Ann" };

  it("uses the full-text index when no from/to operator was parsed", async () => {
    searchEmailsDecrypted.mockResolvedValue({ rows: [] });
    await searchInbox({ data: { query: "invoice" } });
    expect(searchEmailsDecrypted).toHaveBeenCalledWith({
      userId: TEST_USER,
      query: "invoice",
      limit: 100,
      offset: 0,
      accountId: null,
    });
    expect(searchEmailsParticipantsDecrypted).not.toHaveBeenCalled();
  });

  it("routes to the participant index as soon as from or to is present", async () => {
    await searchInbox({ data: { query: "from:ann", from: "ann", rest: "" } });
    expect(searchEmailsParticipantsDecrypted).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER, from: "ann", to: null }),
    );
    expect(searchEmailsDecrypted).not.toHaveBeenCalled();
  });

  it("merges hits with metadata scoped to the authenticated user", async () => {
    searchEmailsDecrypted.mockResolvedValue({ rows: [hit] });
    fake.seedRaw("emails", [{ id: UUID_A, user_id: TEST_USER, is_read: false, thread_id: "t1" }]);

    const res = await searchInbox({ data: { query: "invoice" } });

    expect(res.error).toBeNull();
    // Ranked fields come from the hit; list metadata from the SELECT.
    expect(res.rows[0]).toMatchObject({ id: UUID_A, subject: "Subject", thread_id: "t1" });
    // The metadata SELECT runs on the admin client, which bypasses RLS —
    // the user_id filter is the only thing keeping it in-tenant.
    expect(fake.calls.selects[0]?.filters).toEqual([
      { op: "in", col: "id", value: [UUID_A], extra: undefined },
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
    ]);
  });

  it("drops a hit whose email disappeared before the metadata select", async () => {
    searchEmailsDecrypted.mockResolvedValue({ rows: [hit] });
    // Nothing seeded: the row was deleted between the RPC and the select.
    expect(await searchInbox({ data: { query: "invoice" } })).toEqual({ rows: [], error: null });
  });

  it("skips the metadata select entirely when the search found nothing", async () => {
    searchEmailsDecrypted.mockResolvedValue({ rows: [] });
    expect(await searchInbox({ data: { query: "invoice" } })).toEqual({ rows: [], error: null });
    expect(fake.calls.selects).toEqual([]);
  });

  it("surfaces search and metadata errors", async () => {
    searchEmailsDecrypted.mockResolvedValue({ rows: [], error: "index down" });
    expect(await searchInbox({ data: { query: "q" } })).toEqual({ rows: [], error: "index down" });

    searchEmailsDecrypted.mockResolvedValue({ rows: [hit] });
    fake.onSelect("emails", () => ({ message: "meta boom" }));
    expect(await searchInbox({ data: { query: "q" } })).toEqual({ rows: [], error: "meta boom" });
  });

  it("rejects an empty query and out-of-range pagination", async () => {
    await expect(searchInbox({ data: { query: "   " } })).rejects.toThrow();
    await expect(searchInbox({ data: { query: "q", limit: 201 } })).rejects.toThrow();
    await expect(searchInbox({ data: { query: "q", offset: 10001 } })).rejects.toThrow();
  });

  it("trims the query before handing it to the index", async () => {
    await searchInbox({ data: { query: "  invoice  " } });
    expect(searchEmailsDecrypted).toHaveBeenCalledWith(
      expect.objectContaining({ query: "invoice" }),
    );
  });
});
