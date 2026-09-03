// Unit tests for the per-folder mark-read scope server fns
// (src/lib/gmail/mark-read-rules.functions.ts). Contracts pinned here:
//
//   - every fn resolves the folder through getOwnedFolder first, so another
//     user's folder id is refused before any read of its rules or any write;
//   - normalization: a user-entered value is trimmed, lowercased and stripped
//     of a leading "@"; anything still containing "@" is an `email` entry and
//     everything else a `domain` entry; a value with no dot left is rejected;
//   - the upsert always carries the caller's user_id and conflicts on
//     (folder_id, match_type, value), so re-adding an entry is idempotent;
//   - setSenderMarkRead is the filter drawer's writer: it patches the folder's
//     scope only when the scope actually changes, then adds or removes exactly
//     the one entry the user acted on — never a broader domain rule that
//     happens to cover it;
//   - every mutating fn evicts the account context cache, otherwise the sync
//     pipeline keeps applying the previous scope.

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

const invalidateAccountContext = vi.fn<(accountId: string) => void>();
vi.mock("../sync/account-context", () => ({
  invalidateAccountContext: (accountId: string) => invalidateAccountContext(accountId),
}));

import {
  listFolderMarkReadRules,
  addFolderMarkReadRule,
  removeFolderMarkReadRule,
  getFolderMarkReadDecision,
  setSenderMarkRead,
} from "./mark-read-rules.functions";

const FOLDER = "11111111-1111-4111-8111-111111111111";
const OTHER_FOLDER = "22222222-2222-4222-8222-222222222222";
const RULE = "33333333-3333-4333-8333-333333333333";
const OTHER_RULE = "44444444-4444-4444-8444-444444444444";
const ACC = "55555555-5555-4555-8555-555555555555";
const ATTACKER = "attacker-user";

type Scope = { auto_mark_read: boolean; mark_read_mode: "all" | "except" | "only" };

function seedFolders(scope: Scope = { auto_mark_read: false, mark_read_mode: "all" }) {
  fake.seed("folders", [
    {
      id: FOLDER,
      user_id: TEST_USER,
      gmail_account_id: ACC,
      name: "Vendors",
      auto_mark_read: scope.auto_mark_read,
      mark_read_mode: scope.mark_read_mode,
    },
    {
      id: OTHER_FOLDER,
      user_id: "victim-user",
      gmail_account_id: ACC,
      name: "Theirs",
      auto_mark_read: false,
      mark_read_mode: "all",
    },
  ]);
}

beforeEach(() => {
  fake.reset();
  seedFolders();
  fake.seed("folder_mark_read_rules", []);
});

describe("folder ownership guard", () => {
  const fns = [
    ["listFolderMarkReadRules", listFolderMarkReadRules],
    ["addFolderMarkReadRule", addFolderMarkReadRule],
    ["removeFolderMarkReadRule", removeFolderMarkReadRule],
    ["getFolderMarkReadDecision", getFolderMarkReadDecision],
    ["setSenderMarkRead", setSenderMarkRead],
  ] as const;

  it.each(fns)("%s refuses a folder owned by another user", async (_name, fn) => {
    fake.seed("folder_mark_read_rules", [
      {
        id: OTHER_RULE,
        user_id: "victim-user",
        folder_id: OTHER_FOLDER,
        match_type: "domain",
        value: "acme.com",
      },
    ]);
    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(
          fn,
          ATTACKER,
        )({
          data: { folder_id: OTHER_FOLDER, id: OTHER_RULE, value: "acme.com", mark_read: true },
        }),
      rejects: "Not authorized",
    });
    expect(invalidateAccountContext).not.toHaveBeenCalled();
  });

  it("reports a folder that does not exist as not found, not as unauthorized", async () => {
    await expect(
      listFolderMarkReadRules({ data: { folder_id: "99999999-9999-4999-8999-999999999999" } }),
    ).rejects.toThrow("Folder not found");
  });
});

describe("listFolderMarkReadRules", () => {
  it("returns the folder's rules ordered by value", async () => {
    fake.seed("folder_mark_read_rules", [
      { id: RULE, user_id: TEST_USER, folder_id: FOLDER, match_type: "domain", value: "zeta.com" },
      {
        id: OTHER_RULE,
        user_id: TEST_USER,
        folder_id: FOLDER,
        match_type: "email",
        value: "a@acme.com",
      },
    ]);

    const result = await listFolderMarkReadRules({ data: { folder_id: FOLDER } });

    // The fake does not project columns, so the shape is pinned on the query
    // and the ordering/scoping on the rows it returns.
    const read = fake.calls.selects.find((s) => s.table === "folder_mark_read_rules");
    expect(read?.columns).toBe("id, folder_id, match_type, value");
    expect(read?.filters).toStrictEqual([
      { op: "eq", col: "folder_id", value: FOLDER, extra: undefined },
    ]);
    expect(result.rules.map((r) => [r.id, r.match_type, r.value])).toStrictEqual([
      [OTHER_RULE, "email", "a@acme.com"],
      [RULE, "domain", "zeta.com"],
    ]);
  });

  it("returns only the requested folder's rules", async () => {
    fake.seed("folder_mark_read_rules", [
      { id: RULE, user_id: TEST_USER, folder_id: FOLDER, match_type: "domain", value: "acme.com" },
      {
        id: OTHER_RULE,
        user_id: "victim-user",
        folder_id: OTHER_FOLDER,
        match_type: "domain",
        value: "acme.com",
      },
    ]);

    const result = await listFolderMarkReadRules({ data: { folder_id: FOLDER } });

    expect(result.rules.map((r) => r.id)).toStrictEqual([RULE]);
  });
});

describe("addFolderMarkReadRule", () => {
  it("normalizes ' @Acme.COM ' to a lowercase domain entry and upserts on the natural key", async () => {
    const result = await addFolderMarkReadRule({
      data: { folder_id: FOLDER, value: " @Acme.COM " },
    });

    expect(fake.calls.upserts).toStrictEqual([
      {
        table: "folder_mark_read_rules",
        payload: {
          user_id: TEST_USER,
          folder_id: FOLDER,
          match_type: "domain",
          value: "acme.com",
        },
        options: { onConflict: "folder_id,match_type,value" },
        filters: [],
      },
    ]);
    expect(invalidateAccountContext).toHaveBeenCalledWith(ACC);
    expect(result.rules).toHaveLength(1);
  });

  it("classifies a value containing '@' as an email entry", async () => {
    await addFolderMarkReadRule({ data: { folder_id: FOLDER, value: "  Billing@Acme.com " } });

    expect(fake.calls.upserts[0]?.payload).toMatchObject({
      match_type: "email",
      value: "billing@acme.com",
    });
  });

  it("rejects a bare hostname with no dot, writing nothing", async () => {
    await expect(
      addFolderMarkReadRule({ data: { folder_id: FOLDER, value: "localhost" } }),
    ).rejects.toThrow("Enter an email address or a domain");

    expect(writeCount(fake)).toBe(0);
    expect(invalidateAccountContext).not.toHaveBeenCalled();
  });

  it("rejects a value shorter than the schema minimum before normalizing", async () => {
    await expect(
      addFolderMarkReadRule({ data: { folder_id: FOLDER, value: "a." } }),
    ).rejects.toThrow();
    expect(fake.calls.selects).toHaveLength(0);
  });

  it("surfaces the upsert failure and leaves the account context cached", async () => {
    fake.onUpsert("folder_mark_read_rules", () => ({ message: "duplicate key" }));

    await expect(
      addFolderMarkReadRule({ data: { folder_id: FOLDER, value: "acme.com" } }),
    ).rejects.toThrow("duplicate key");
    expect(invalidateAccountContext).not.toHaveBeenCalled();
  });
});

describe("removeFolderMarkReadRule", () => {
  it("deletes by id scoped to the folder and the caller", async () => {
    fake.seed("folder_mark_read_rules", [
      { id: RULE, user_id: TEST_USER, folder_id: FOLDER, match_type: "domain", value: "acme.com" },
    ]);

    const result = await removeFolderMarkReadRule({ data: { folder_id: FOLDER, id: RULE } });

    expect(fake.calls.deletes).toStrictEqual([
      {
        table: "folder_mark_read_rules",
        payload: null,
        options: undefined,
        filters: [
          { op: "eq", col: "id", value: RULE, extra: undefined },
          { op: "eq", col: "folder_id", value: FOLDER, extra: undefined },
          { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
        ],
      },
    ]);
    expect(result).toStrictEqual({ rules: [] });
    expect(invalidateAccountContext).toHaveBeenCalledWith(ACC);
  });
});

describe("getFolderMarkReadDecision", () => {
  it("probes a bare domain as an address at that domain", async () => {
    seedFolders({ auto_mark_read: true, mark_read_mode: "except" });
    fake.seed("folder_mark_read_rules", [
      { id: RULE, user_id: TEST_USER, folder_id: FOLDER, match_type: "domain", value: "acme.com" },
    ]);

    const result = await getFolderMarkReadDecision({
      data: { folder_id: FOLDER, value: "ACME.com" },
    });

    expect(result).toStrictEqual({
      auto_mark_read: true,
      mark_read_mode: "except",
      listed: true,
      would_mark_read: false,
    });
  });

  it("reports an unlisted sender under 'only' as not marked read", async () => {
    seedFolders({ auto_mark_read: true, mark_read_mode: "only" });

    const result = await getFolderMarkReadDecision({
      data: { folder_id: FOLDER, value: "someone@acme.com" },
    });

    expect(result).toStrictEqual({
      auto_mark_read: true,
      mark_read_mode: "only",
      listed: false,
      would_mark_read: false,
    });
  });

  it("defaults a folder with no stored mode to 'all'", async () => {
    fake.seed("folders", [
      {
        id: FOLDER,
        user_id: TEST_USER,
        gmail_account_id: ACC,
        auto_mark_read: true,
        mark_read_mode: null,
      },
    ]);

    const result = await getFolderMarkReadDecision({
      data: { folder_id: FOLDER, value: "acme.com" },
    });

    expect(result).toStrictEqual({
      auto_mark_read: true,
      mark_read_mode: "all",
      listed: false,
      would_mark_read: true,
    });
  });
});

describe("setSenderMarkRead", () => {
  it("turns an 'all' folder into 'except' and lists the sender when asked to leave it unread", async () => {
    seedFolders({ auto_mark_read: true, mark_read_mode: "all" });

    const result = await setSenderMarkRead({
      data: { folder_id: FOLDER, value: "@Acme.COM", mark_read: false },
    });

    expect(result).toStrictEqual({
      auto_mark_read: true,
      mark_read_mode: "except",
      listed: true,
      changed: true,
    });
    expect(fake.calls.updates).toStrictEqual([
      {
        table: "folders",
        payload: { auto_mark_read: true, mark_read_mode: "except" },
        options: undefined,
        filters: [
          { op: "eq", col: "id", value: FOLDER, extra: undefined },
          { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
        ],
      },
    ]);
    expect(fake.calls.upserts[0]?.payload).toStrictEqual({
      user_id: TEST_USER,
      folder_id: FOLDER,
      match_type: "domain",
      value: "acme.com",
    });
    expect(fake.calls.deletes).toHaveLength(0);
    expect(invalidateAccountContext).toHaveBeenCalledWith(ACC);
  });

  it("removes only the exact entry, by folder + user + match_type + value", async () => {
    seedFolders({ auto_mark_read: true, mark_read_mode: "except" });
    fake.seed("folder_mark_read_rules", [
      {
        id: RULE,
        user_id: TEST_USER,
        folder_id: FOLDER,
        match_type: "email",
        value: "billing@acme.com",
      },
      // A broader domain exemption that also covers the address: must survive.
      {
        id: OTHER_RULE,
        user_id: TEST_USER,
        folder_id: FOLDER,
        match_type: "domain",
        value: "acme.com",
      },
    ]);

    const result = await setSenderMarkRead({
      data: { folder_id: FOLDER, value: "Billing@Acme.com", mark_read: true },
    });

    expect(result).toStrictEqual({
      auto_mark_read: true,
      mark_read_mode: "except",
      listed: false,
      changed: true,
    });
    expect(fake.calls.deletes).toStrictEqual([
      {
        table: "folder_mark_read_rules",
        payload: null,
        options: undefined,
        filters: [
          { op: "eq", col: "folder_id", value: FOLDER, extra: undefined },
          { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
          { op: "eq", col: "match_type", value: "email", extra: undefined },
          { op: "eq", col: "value", value: "billing@acme.com", extra: undefined },
        ],
      },
    ]);
    expect(fake.rows("folder_mark_read_rules").map((r) => r.id)).toStrictEqual([OTHER_RULE]);
  });

  it("leaves the folder row untouched when only the entry changes", async () => {
    seedFolders({ auto_mark_read: true, mark_read_mode: "except" });

    await setSenderMarkRead({
      data: { folder_id: FOLDER, value: "acme.com", mark_read: false },
    });

    expect(fake.calls.updates).toHaveLength(0);
    expect(fake.calls.upserts).toHaveLength(1);
  });

  it("switches a folder that does not auto mark-read into 'only' rather than marking everything read", async () => {
    seedFolders({ auto_mark_read: false, mark_read_mode: "all" });

    const result = await setSenderMarkRead({
      data: { folder_id: FOLDER, value: "acme.com", mark_read: true },
    });

    expect(result).toStrictEqual({
      auto_mark_read: true,
      mark_read_mode: "only",
      listed: true,
      changed: true,
    });
    expect(fake.calls.updates[0]?.payload).toStrictEqual({
      auto_mark_read: true,
      mark_read_mode: "only",
    });
  });

  it("rejects a value with no dot before reading the folder's scope", async () => {
    seedFolders({ auto_mark_read: true, mark_read_mode: "all" });

    await expect(
      setSenderMarkRead({ data: { folder_id: FOLDER, value: "localhost", mark_read: true } }),
    ).rejects.toThrow("Enter an email address or a domain");
    expect(writeCount(fake)).toBe(0);
  });

  it("surfaces a failed folder patch without touching the rule list", async () => {
    seedFolders({ auto_mark_read: true, mark_read_mode: "all" });
    fake.onUpdate("folders", () => ({ message: "row level security" }));

    await expect(
      setSenderMarkRead({ data: { folder_id: FOLDER, value: "acme.com", mark_read: false } }),
    ).rejects.toThrow("row level security");
    expect(fake.calls.upserts).toHaveLength(0);
    expect(fake.calls.deletes).toHaveLength(0);
    expect(invalidateAccountContext).not.toHaveBeenCalled();
  });
});
