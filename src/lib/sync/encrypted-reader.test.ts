// Unit tests for the decrypt-RPC wrappers — the read side of the encryption
// boundary. Every read of sensitive plaintext goes through these functions,
// so the contracts under test are load-bearing:
//
//   * the exact RPC name and argument mapping (a typo'd RPC name or param
//     silently returns nothing in production),
//   * EMAIL_ENC_KEY is required up front — never a silent fallback,
//   * RPC errors are RETURNED ({ rows: [], error }), never thrown — sweep
//     jobs like rescue depend on that to abort cleanly,
//   * empty inputs short-circuit without a round-trip.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

// Property accesses are deferred into method bodies so the hoisted factory
// never touches `fake` before its initializer runs.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

import {
  claimForwardRetriesDecrypted,
  getContactDecrypted,
  getContactListFieldsDecrypted,
  getEmailListFieldsDecrypted,
  getEmailsDecrypted,
  getEmailsListDecrypted,
  getReplyDraftDecrypted,
  searchEmailsDecrypted,
  searchEmailsParticipantsDecrypted,
} from "./encrypted-reader";

const KEY = "test-enc-key";
const savedKey = process.env.EMAIL_ENC_KEY;

beforeEach(() => {
  fake.reset();
  process.env.EMAIL_ENC_KEY = KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.EMAIL_ENC_KEY;
  else process.env.EMAIL_ENC_KEY = savedKey;
});

describe("empty-input short-circuits", () => {
  it("returns { rows: [], error: null } for empty id lists without any RPC", async () => {
    expect(await getEmailsDecrypted([])).toEqual({ rows: [], error: null });
    expect(await getEmailListFieldsDecrypted([])).toEqual({ rows: [], error: null });
    expect(await getContactListFieldsDecrypted([])).toEqual({ rows: [], error: null });
    expect(fake.calls.rpcs).toHaveLength(0);
  });
});

describe("EMAIL_ENC_KEY guard", () => {
  it("rejects before issuing any RPC when the key is unset", async () => {
    delete process.env.EMAIL_ENC_KEY;
    await expect(getEmailsDecrypted(["e1"])).rejects.toThrow("EMAIL_ENC_KEY not configured");
    await expect(getContactDecrypted("c1")).rejects.toThrow("EMAIL_ENC_KEY not configured");
    await expect(getReplyDraftDecrypted("e1")).rejects.toThrow("EMAIL_ENC_KEY not configured");
    await expect(claimForwardRetriesDecrypted(5)).rejects.toThrow("EMAIL_ENC_KEY not configured");
    expect(fake.calls.rpcs).toHaveLength(0);
  });
});

describe("RPC name + argument mapping", () => {
  it("getEmailsDecrypted calls get_emails_decrypted with p_ids and p_key", async () => {
    const row = { id: "e1", subject: "hi" };
    fake.onRpc("get_emails_decrypted", () => [row]);
    const res = await getEmailsDecrypted(["e1", "e2"]);
    expect(fake.calls.rpcs).toEqual([
      { fn: "get_emails_decrypted", args: { p_ids: ["e1", "e2"], p_key: KEY } },
    ]);
    expect(res).toEqual({ rows: [row], error: null });
  });

  it("getEmailListFieldsDecrypted calls get_emails_list_fields_decrypted", async () => {
    await getEmailListFieldsDecrypted(["e1"]);
    expect(fake.calls.rpcs).toEqual([
      { fn: "get_emails_list_fields_decrypted", args: { p_ids: ["e1"], p_key: KEY } },
    ]);
  });

  it("getContactListFieldsDecrypted calls get_contacts_list_fields_decrypted", async () => {
    await getContactListFieldsDecrypted(["c1"]);
    expect(fake.calls.rpcs).toEqual([
      { fn: "get_contacts_list_fields_decrypted", args: { p_ids: ["c1"], p_key: KEY } },
    ]);
  });

  it("getEmailsListDecrypted maps every list arg verbatim", async () => {
    await getEmailsListDecrypted({
      accountId: "acc-1",
      userId: "user-1",
      scope: "folder",
      folderId: "f-1",
      cursor: "2026-01-01T00:00:00Z",
      limit: 50,
    });
    expect(fake.calls.rpcs).toEqual([
      {
        fn: "get_emails_list_decrypted",
        args: {
          p_account_id: "acc-1",
          p_user_id: "user-1",
          p_scope: "folder",
          p_folder_id: "f-1",
          p_cursor: "2026-01-01T00:00:00Z",
          p_limit: 50,
          p_key: KEY,
        },
      },
    ]);
  });

  it("searchEmailsDecrypted calls search_emails with paging + account args", async () => {
    await searchEmailsDecrypted({
      userId: "user-1",
      query: "invoice",
      limit: 20,
      offset: 40,
      accountId: null,
    });
    expect(fake.calls.rpcs).toEqual([
      {
        fn: "search_emails",
        args: {
          p_user_id: "user-1",
          p_query: "invoice",
          p_limit: 20,
          p_offset: 40,
          p_key: KEY,
          p_account_id: null,
        },
      },
    ]);
  });

  it("searchEmailsParticipantsDecrypted calls search_emails_participants", async () => {
    await searchEmailsParticipantsDecrypted({
      userId: "user-1",
      from: "a@x.com",
      to: null,
      rest: "hello",
      limit: 10,
      offset: 0,
      accountId: "acc-1",
    });
    expect(fake.calls.rpcs).toEqual([
      {
        fn: "search_emails_participants",
        args: {
          p_user_id: "user-1",
          p_from: "a@x.com",
          p_to: null,
          p_rest: "hello",
          p_limit: 10,
          p_offset: 0,
          p_key: KEY,
          p_account_id: "acc-1",
        },
      },
    ]);
  });

  it("claimForwardRetriesDecrypted calls claim_forward_retries_v2 with p_limit", async () => {
    await claimForwardRetriesDecrypted(7);
    expect(fake.calls.rpcs).toEqual([
      { fn: "claim_forward_retries_v2", args: { p_limit: 7, p_key: KEY } },
    ]);
  });
});

describe("error and null-data contracts", () => {
  it("returns the RPC error message instead of throwing", async () => {
    fake.onRpc("get_emails_decrypted", () => ({ error: { message: "decrypt failed" } }));
    expect(await getEmailsDecrypted(["e1"])).toEqual({ rows: [], error: "decrypt failed" });

    fake.onRpc("get_contact_decrypted", () => ({ error: { message: "boom" } }));
    expect(await getContactDecrypted("c1")).toEqual({ row: null, error: "boom" });

    fake.onRpc("get_reply_draft_decrypted", () => ({ error: { message: "nope" } }));
    expect(await getReplyDraftDecrypted("e1")).toEqual({ draft_text: null, error: "nope" });
  });

  it("treats null RPC data as empty, not a crash", async () => {
    // No handlers registered: every RPC resolves { data: null, error: null }.
    expect(await getEmailsDecrypted(["e1"])).toEqual({ rows: [], error: null });
    expect(await getContactDecrypted("c1")).toEqual({ row: null, error: null });
    expect(await getReplyDraftDecrypted("e1")).toEqual({ draft_text: null, error: null });
    expect(await claimForwardRetriesDecrypted(3)).toEqual({ rows: [], error: null });
  });

  it("getContactDecrypted returns only the first row", async () => {
    fake.onRpc("get_contact_decrypted", () => [{ id: "c1" }, { id: "c2" }]);
    const res = await getContactDecrypted("c1");
    expect(res).toEqual({ row: { id: "c1" }, error: null });
  });

  it("getReplyDraftDecrypted returns null when the row exists with a null draft", async () => {
    fake.onRpc("get_reply_draft_decrypted", () => [{ draft_text: null }]);
    expect(await getReplyDraftDecrypted("e1")).toEqual({ draft_text: null, error: null });

    fake.onRpc("get_reply_draft_decrypted", () => [{ draft_text: "draft body" }]);
    expect(await getReplyDraftDecrypted("e1")).toEqual({ draft_text: "draft body", error: null });
  });
});
