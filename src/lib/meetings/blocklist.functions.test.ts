// Unit tests for the don't-auto-record list
// (src/lib/meetings/blocklist.functions.ts). This list is what keeps a bot
// out of a call with someone who never consented, so the contracts are the
// input validation (only a real address or domain gets in), the lowercase
// normalization that makes the later match work, and that every read and
// write is scoped to the caller's own user id on top of RLS.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { callWithRlsClient } from "@/lib/__fixtures__/rls-server-fn";

const fake = makeSupabaseFake({ applyWrites: true });

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));

import {
  addRecordBlocklistEntry,
  listRecordBlocklist,
  removeRecordBlocklistEntry,
} from "./blocklist.functions";

const ENTRY = "11111111-1111-4111-8111-111111111111";
const FOREIGN_ENTRY = "22222222-2222-4222-8222-222222222222";
const ATTACKER = "attacker-user";

const call = <F extends (args: never) => Promise<unknown>>(fn: F) =>
  callWithRlsClient(fn, { fake });
const callAs = <F extends (args: never) => Promise<unknown>>(fn: F, userId: string) =>
  callWithRlsClient(fn, { fake, userId });

beforeEach(() => {
  fake.reset();
});

describe("listRecordBlocklist", () => {
  it("returns only the caller's entries, alphabetically", async () => {
    fake.seed("meeting_record_blocklist", [
      { id: ENTRY, user_id: TEST_USER, value: "zed@acme.com", created_at: "2026-01-01T00:00:00Z" },
      { id: "e2", user_id: TEST_USER, value: "acme.com", created_at: "2026-01-02T00:00:00Z" },
      {
        id: FOREIGN_ENTRY,
        user_id: ATTACKER,
        value: "aaa@other.com",
        created_at: "2026-01-03T00:00:00Z",
      },
    ]);

    const result = await call(listRecordBlocklist)();

    expect(result.entries.map((e) => e.value)).toStrictEqual(["acme.com", "zed@acme.com"]);
  });

  it("surfaces a failing read", async () => {
    fake.onSelect("meeting_record_blocklist", () => ({ message: "read denied" }));

    await expect(call(listRecordBlocklist)()).rejects.toThrow("read denied");
  });
});

describe("addRecordBlocklistEntry", () => {
  it("lowercases and trims an address before storing it", async () => {
    const result = await call(addRecordBlocklistEntry)({ data: { value: "  Legal@ACME.com  " } });

    expect(result).toStrictEqual({ ok: true, value: "legal@acme.com" });
    expect(fake.calls.upserts.map((w) => [w.table, w.payload, w.options])).toStrictEqual([
      [
        "meeting_record_blocklist",
        { user_id: TEST_USER, value: "legal@acme.com" },
        { onConflict: "user_id,value", ignoreDuplicates: true },
      ],
    ]);
  });

  it("accepts a bare domain", async () => {
    await expect(
      call(addRecordBlocklistEntry)({ data: { value: "ACME.co.uk" } }),
    ).resolves.toStrictEqual({ ok: true, value: "acme.co.uk" });
  });

  it("rejects anything that is neither an address nor a domain", async () => {
    for (const value of ["not a domain", "@acme", "acme", "http://acme.com", ""]) {
      await expect(call(addRecordBlocklistEntry)({ data: { value } })).rejects.toThrow();
    }
    expect(writeCount(fake)).toBe(0);
  });

  it("re-adding an existing entry is a no-op rather than an error", async () => {
    fake.seed("meeting_record_blocklist", [
      { id: ENTRY, user_id: TEST_USER, value: "legal@acme.com" },
    ]);

    await expect(
      call(addRecordBlocklistEntry)({ data: { value: "legal@acme.com" } }),
    ).resolves.toStrictEqual({ ok: true, value: "legal@acme.com" });
    expect(fake.rows("meeting_record_blocklist")).toHaveLength(1);
  });

  it("surfaces a rejected write", async () => {
    fake.onUpsert("meeting_record_blocklist", () => ({ message: "upsert denied" }));

    await expect(
      call(addRecordBlocklistEntry)({ data: { value: "legal@acme.com" } }),
    ).rejects.toThrow("upsert denied");
  });
});

describe("removeRecordBlocklistEntry", () => {
  it("deletes the caller's own entry", async () => {
    fake.seed("meeting_record_blocklist", [
      { id: ENTRY, user_id: TEST_USER, value: "legal@acme.com" },
    ]);

    await expect(call(removeRecordBlocklistEntry)({ data: { id: ENTRY } })).resolves.toStrictEqual({
      ok: true,
    });
    expect(fake.rows("meeting_record_blocklist")).toStrictEqual([]);
    expect(fake.calls.deletes[0]?.filters).toStrictEqual([
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
      { op: "eq", col: "id", value: ENTRY, extra: undefined },
    ]);
  });

  it("leaves another user's entry in place", async () => {
    fake.seed("meeting_record_blocklist", [
      { id: ENTRY, user_id: TEST_USER, value: "legal@acme.com" },
    ]);

    // The delete reports success either way — the proof is the surviving row.
    await callAs(removeRecordBlocklistEntry, ATTACKER)({ data: { id: ENTRY } });

    expect(fake.rows("meeting_record_blocklist")).toHaveLength(1);
  });

  it("surfaces a rejected delete", async () => {
    fake.onDelete("meeting_record_blocklist", () => ({ message: "delete denied" }));

    await expect(call(removeRecordBlocklistEntry)({ data: { id: ENTRY } })).rejects.toThrow(
      "delete denied",
    );
  });
});
