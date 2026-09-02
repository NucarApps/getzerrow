// Unit tests for the folder settings chat server functions
// (src/lib/folder-chat.functions.ts). Contracts pinned here:
//
//   - all four entry points verify folder ownership on the service-role
//     client BEFORE anything else — for proposeFolderChanges that means
//     before the model is ever called (a cross-tenant prompt would leak the
//     victim's folder context into the gateway);
//   - the replayed history window is capped and scoped to the folder;
//   - applyFolderChanges pre-verifies every referenced filter belongs to
//     THIS folder, normalizes add_filter values per field/op, treats an
//     identical existing filter as a no-op, and isolates per-action
//     failures so one bad action does not abort the rest.
//
// Harness: __fixtures__/server-fn-stub + __fixtures__/supabase-fake.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";
import type { FolderChatAction, FolderChatProposal } from "./folder-chat.server";

const fake = makeSupabaseFake();

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

const { proposeFolderChatChanges, summarizeFolderChat, getEmailsDecrypted } = vi.hoisted(() => ({
  proposeFolderChatChanges: vi.fn<typeof import("./folder-chat.server").proposeFolderChatChanges>(),
  summarizeFolderChat: vi.fn<typeof import("./folder-chat.server").summarizeFolderChat>(),
  getEmailsDecrypted: vi.fn<typeof import("./sync/encrypted-reader").getEmailsDecrypted>(),
}));
vi.mock("./folder-chat.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./folder-chat.server")>();
  return {
    ...actual,
    proposeFolderChatChanges,
    summarizeFolderChat,
  } satisfies typeof import("./folder-chat.server");
});
vi.mock("./sync/encrypted-reader", () => ({ getEmailsDecrypted }));

import {
  applyFolderChanges,
  discardFolderChanges,
  getFolderChatHistory,
  proposeFolderChanges,
} from "./folder-chat.functions";

const FOLDER = "11111111-1111-4111-8111-111111111111";
const OTHER_FOLDER = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const MESSAGE = "44444444-4444-4444-8444-444444444444";
const FILTER_MINE = "55555555-5555-4555-8555-555555555555";
const FILTER_FOREIGN = "66666666-6666-4666-8666-666666666666";
const ATTACKER = "attacker-user";

function emptyProposal(overrides?: Partial<FolderChatProposal>): FolderChatProposal {
  return { reply: "ok", clarifying_question: "", actions: [], ...overrides };
}

function seedFolder(ownerId: string = TEST_USER) {
  fake.seed("folders", [
    {
      id: FOLDER,
      user_id: ownerId,
      gmail_account_id: ACCOUNT,
      name: "Receipts",
      color: "#112233",
      priority: 10,
      ai_rule: "receipts only",
      learned_profile: null,
      auto_archive: false,
      auto_mark_read: false,
      auto_star: false,
      hide_from_inbox: false,
      skip_ai: false,
      overrides_inbox_override: false,
      is_cold_email: false,
      forward_to: null,
      snooze_hours: 0,
      min_ai_confidence: 0.5,
      filter_logic: "any",
    },
  ]);
}

beforeEach(() => {
  fake.reset();
  proposeFolderChatChanges.mockResolvedValue(emptyProposal());
  summarizeFolderChat.mockResolvedValue("summary");
  getEmailsDecrypted.mockResolvedValue({ rows: [], error: null });
});

describe("proposeFolderChanges", () => {
  it("denies a folder owned by another user before the model is called", async () => {
    seedFolder();
    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(
          proposeFolderChanges,
          ATTACKER,
        )({ data: { folder_id: FOLDER, user_message: "make this stricter" } }),
      rejects: "Folder not found",
    });
    expect(
      proposeFolderChatChanges,
      "a cross-tenant prompt must never reach the gateway",
    ).not.toHaveBeenCalled();
  });

  it("rejects a folder id that does not exist at all", async () => {
    await expect(
      proposeFolderChanges({ data: { folder_id: FOLDER, user_message: "hi" } }),
    ).rejects.toThrow("Folder not found");
    expect(writeCount(fake)).toBe(0);
  });

  it("persists both turns and feeds the model the folder, filters and capped history", async () => {
    seedFolder();
    fake.seed("folder_filters", [
      { id: FILTER_MINE, folder_id: FOLDER, field: "domain", op: "equals", value: "acme.com" },
    ]);
    fake.seed("folder_chat_state", [{ folder_id: FOLDER, user_id: TEST_USER, summary: "so far" }]);
    fake.seed("folder_chat_messages", [
      {
        id: MESSAGE,
        folder_id: FOLDER,
        user_id: TEST_USER,
        role: "assistant",
        content: "earlier reply",
        created_at: "2026-01-01T00:00:00Z",
        actions: [{ type: "update_folder_rule", ai_rule: "only receipts", why: "" }],
        applied_action_indexes: [0],
        discarded: false,
      },
    ]);
    proposeFolderChatChanges.mockResolvedValue(
      emptyProposal({
        reply: "done",
        actions: [{ type: "remove_filter", filter_id: FILTER_MINE, why: "" }],
      }),
    );
    fake.onInsert("folder_chat_messages", (payload) => {
      const row = payload as { role: string };
      return row.role === "assistant" ? { data: { id: MESSAGE } } : null;
    });

    const result = await proposeFolderChanges({
      data: { folder_id: FOLDER, user_message: "drop the acme rule" },
    });

    expect(result.message_id).toBe(MESSAGE);
    expect(result.reply).toBe("done");

    const arg = proposeFolderChatChanges.mock.calls[0]?.[0];
    expect(arg?.userMessage).toBe("drop the acme rule");
    expect(arg?.memorySummary).toBe("so far");
    expect(arg?.history).toStrictEqual([{ role: "assistant", content: "earlier reply" }]);
    expect(arg?.appliedLog).toStrictEqual(['Set AI rule to "only receipts"']);
    expect(arg?.rejectedLog).toStrictEqual([]);
    expect(arg?.folder.filters).toStrictEqual([
      { id: FILTER_MINE, field: "domain", op: "equals", value: "acme.com" },
    ]);

    const inserted = fake.calls.inserts.filter((w) => w.table === "folder_chat_messages");
    expect(inserted.map((w) => w.payload)).toStrictEqual([
      {
        folder_id: FOLDER,
        user_id: TEST_USER,
        role: "user",
        content: "drop the acme rule",
      },
      {
        folder_id: FOLDER,
        user_id: TEST_USER,
        role: "assistant",
        content: "done",
        actions: [{ type: "remove_filter", filter_id: FILTER_MINE, why: "" }],
      },
    ]);

    const historyRead = fake.calls.selects.find(
      (s) => s.table === "folder_chat_messages" && s.columns?.includes("applied_action_indexes"),
    );
    expect(historyRead?.filters).toStrictEqual([
      { op: "eq", col: "folder_id", value: FOLDER, extra: undefined },
    ]);
  });

  it("records a discarded turn's unapplied actions as rejected so the model stops re-suggesting them", async () => {
    seedFolder();
    fake.seed("folder_chat_messages", [
      {
        id: MESSAGE,
        folder_id: FOLDER,
        user_id: TEST_USER,
        role: "assistant",
        content: "how about these",
        created_at: "2026-01-01T00:00:00Z",
        actions: [
          { type: "update_folder_rule", ai_rule: "kept", why: "" },
          { type: "update_folder_profile", learned_profile: "tossed", why: "" },
        ],
        applied_action_indexes: [0],
        discarded: true,
      },
    ]);

    await proposeFolderChanges({ data: { folder_id: FOLDER, user_message: "again" } });

    const arg = proposeFolderChatChanges.mock.calls[0]?.[0];
    expect(arg?.appliedLog).toStrictEqual(['Set AI rule to "kept"']);
    expect(arg?.rejectedLog).toStrictEqual(["Rewrote the learned profile"]);
  });

  it("surfaces a gateway failure instead of persisting a half-finished turn", async () => {
    seedFolder();
    proposeFolderChatChanges.mockRejectedValue(new Error("gateway 503"));

    await expect(
      proposeFolderChanges({ data: { folder_id: FOLDER, user_message: "hi" } }),
    ).rejects.toThrow("gateway 503");

    const inserted = fake.calls.inserts.filter((w) => w.table === "folder_chat_messages");
    expect(inserted).toHaveLength(1);
    expect((inserted[0]?.payload as { role: string }).role).toBe("user");
  });
});

describe("getFolderChatHistory", () => {
  it("denies a folder owned by another user", async () => {
    seedFolder();
    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(getFolderChatHistory, ATTACKER)({ data: { folder_id: FOLDER } }),
      rejects: "Folder not found",
    });
  });

  it("returns stored turns oldest-first with unparseable actions dropped", async () => {
    seedFolder();
    fake.seed("folder_chat_state", [{ folder_id: FOLDER, user_id: TEST_USER, summary: "memory" }]);
    fake.seed("folder_chat_messages", [
      {
        id: MESSAGE,
        folder_id: FOLDER,
        user_id: TEST_USER,
        role: "assistant",
        content: "second",
        created_at: "2026-01-02T00:00:00Z",
        actions: [
          { type: "update_folder_rule", ai_rule: "keep", why: "" },
          { type: "not_a_real_action" },
        ],
        applied_action_indexes: null,
        discarded: null,
      },
      {
        id: "77777777-7777-4777-8777-777777777777",
        folder_id: FOLDER,
        user_id: TEST_USER,
        role: "user",
        content: "first",
        created_at: "2026-01-01T00:00:00Z",
        actions: null,
        applied_action_indexes: null,
        discarded: null,
      },
    ]);

    const result = await getFolderChatHistory({ data: { folder_id: FOLDER } });

    expect(result.summary).toBe("memory");
    expect(result.messages.map((m) => m.content)).toStrictEqual(["first", "second"]);
    expect(result.messages[1]?.actions).toStrictEqual([
      { type: "update_folder_rule", ai_rule: "keep", why: "" },
    ]);
    expect(result.messages[1]?.applied_action_indexes).toStrictEqual([]);
    expect(result.messages[1]?.discarded).toBe(false);
    expect(writeCount(fake)).toBe(0);
  });
});

describe("discardFolderChanges", () => {
  it("denies a folder owned by another user", async () => {
    seedFolder();
    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(
          discardFolderChanges,
          ATTACKER,
        )({ data: { folder_id: FOLDER, message_id: MESSAGE } }),
      rejects: "Folder not found",
    });
  });

  it("marks the message discarded, scoped to the message, folder and caller", async () => {
    seedFolder();

    const result = await discardFolderChanges({
      data: { folder_id: FOLDER, message_id: MESSAGE },
    });

    expect(result).toStrictEqual({ ok: true });
    const updates = fake.calls.updates.filter((w) => w.table === "folder_chat_messages");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload).toStrictEqual({ discarded: true });
    expect(updates[0]?.filters).toStrictEqual([
      { op: "eq", col: "id", value: MESSAGE, extra: undefined },
      { op: "eq", col: "folder_id", value: FOLDER, extra: undefined },
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
    ]);
  });

  it("surfaces a failing update as an error", async () => {
    seedFolder();
    fake.onUpdate("folder_chat_messages", () => ({ message: "update denied" }));

    await expect(
      discardFolderChanges({ data: { folder_id: FOLDER, message_id: MESSAGE } }),
    ).rejects.toThrow("update denied");
  });
});

describe("applyFolderChanges", () => {
  const addFilter: FolderChatAction = {
    type: "add_filter",
    field: "domain",
    op: "equals",
    value: "  ACME.com ",
    why: "",
  };

  it("denies a folder owned by another user before any action runs", async () => {
    seedFolder();
    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(
          applyFolderChanges,
          ATTACKER,
        )({ data: { folder_id: FOLDER, actions: [addFilter] } }),
      rejects: "Folder not found",
    });
  });

  it("normalizes an add_filter value and inserts it against the verified folder", async () => {
    seedFolder();

    const result = await applyFolderChanges({
      data: { folder_id: FOLDER, actions: [{ ...addFilter, value: " @ACME.com " }] },
    });

    expect(result.results.map((r) => r.ok)).toStrictEqual([true]);
    const inserts = fake.calls.inserts.filter((w) => w.table === "folder_filters");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.payload).toStrictEqual({
      folder_id: FOLDER,
      field: "domain",
      op: "equals",
      value: "acme.com",
    });
  });

  it("normalizes a domain_in allowlist to a deduped lowercase comma list", async () => {
    seedFolder();

    await applyFolderChanges({
      data: {
        folder_id: FOLDER,
        actions: [
          {
            type: "add_filter",
            field: "domain",
            op: "domain_in",
            value: "@Acme.com, beta.io;  acme.com \n gamma.dev",
            why: "",
          },
        ],
      },
    });

    const inserts = fake.calls.inserts.filter((w) => w.table === "folder_filters");
    expect(inserts[0]?.payload).toStrictEqual({
      folder_id: FOLDER,
      field: "domain",
      op: "domain_in",
      value: "acme.com,beta.io,gamma.dev",
    });
  });

  it("treats an identical existing filter as a successful no-op", async () => {
    seedFolder();
    fake.seed("folder_filters", [
      { id: FILTER_MINE, folder_id: FOLDER, field: "domain", op: "equals", value: "acme.com" },
    ]);

    const result = await applyFolderChanges({
      data: { folder_id: FOLDER, actions: [addFilter] },
    });

    expect(result.results.map((r) => r.ok)).toStrictEqual([true]);
    expect(fake.calls.inserts.filter((w) => w.table === "folder_filters")).toHaveLength(0);
  });

  // CHARACTERIZATION(folder-chat-skips-conflict-check): applyFolderChanges
  // inserts folder_filters directly without running checkRuleConflicts
  // (src/lib/rules/conflicts.ts), unlike the rules editor — so the chat can
  // create a rule that shadows an existing one with no warning, and the
  // write is not registered as an audited folder-write path. Flip when the
  // conflict check is wired in.
  it("inserts a filter that shadows an existing rule with no conflict report", async () => {
    seedFolder();
    fake.seed("folder_filters", [
      { id: FILTER_MINE, folder_id: FOLDER, field: "domain", op: "equals", value: "acme.com" },
    ]);

    const result = await applyFolderChanges({
      data: {
        folder_id: FOLDER,
        actions: [
          { type: "add_filter", field: "domain", op: "domain_in", value: "acme.com", why: "" },
        ],
      },
    });

    expect(result.results).toStrictEqual([
      {
        action: {
          type: "add_filter",
          field: "domain",
          op: "domain_in",
          value: "acme.com",
          why: "",
        },
        ok: true,
      },
    ]);
    expect(fake.calls.inserts.filter((w) => w.table === "folder_filters")).toHaveLength(1);
  });

  it("rejects removing a filter that belongs to another folder and deletes nothing", async () => {
    seedFolder();
    fake.seed("folder_filters", [
      {
        id: FILTER_FOREIGN,
        folder_id: OTHER_FOLDER,
        field: "domain",
        op: "equals",
        value: "x.com",
      },
    ]);

    const result = await applyFolderChanges({
      data: {
        folder_id: FOLDER,
        actions: [{ type: "remove_filter", filter_id: FILTER_FOREIGN, why: "" }],
      },
    });

    expect(result.results.map((r) => [r.ok, r.error])).toStrictEqual([[false, "Filter not owned"]]);
    expect(fake.calls.deletes).toHaveLength(0);
  });

  it("isolates a failing action so later actions still apply", async () => {
    seedFolder();
    fake.seed("folder_filters", [
      { id: FILTER_MINE, folder_id: FOLDER, field: "domain", op: "equals", value: "keep.com" },
    ]);
    fake.onDelete("folder_filters", () => ({ message: "delete blew up" }));

    const result = await applyFolderChanges({
      data: {
        folder_id: FOLDER,
        actions: [
          { type: "remove_filter", filter_id: FILTER_MINE, why: "" },
          { type: "update_folder_rule", ai_rule: "  only receipts  ", why: "" },
        ],
      },
    });

    expect(result.results.map((r) => [r.ok, r.error])).toStrictEqual([
      [false, "delete blew up"],
      [true, undefined],
    ]);
    const updates = fake.calls.updates.filter((w) => w.table === "folders");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload).toStrictEqual({ ai_rule: "only receipts" });
    expect(updates[0]?.filters).toStrictEqual([
      { op: "eq", col: "id", value: FOLDER, extra: undefined },
    ]);
  });

  it("clamps an out-of-range settings patch and rejects an empty one", async () => {
    seedFolder();

    const result = await applyFolderChanges({
      data: {
        folder_id: FOLDER,
        actions: [
          {
            type: "update_folder_settings",
            settings: { priority: 1000, snooze_hours: 720, min_ai_confidence: 1, forward_to: "  " },
            why: "",
          },
        ],
      },
    });

    expect(result.results.map((r) => r.ok)).toStrictEqual([true]);
    const updates = fake.calls.updates.filter((w) => w.table === "folders");
    expect(updates[0]?.payload).toStrictEqual({
      priority: 1000,
      snooze_hours: 720,
      min_ai_confidence: 1,
      forward_to: null,
    });
  });

  it("reports an empty settings patch as a per-action failure", async () => {
    seedFolder();

    const result = await applyFolderChanges({
      data: {
        folder_id: FOLDER,
        actions: [{ type: "update_folder_settings", settings: {}, why: "" }],
      },
    });

    expect(result.results.map((r) => [r.ok, r.error])).toStrictEqual([
      [false, "No settings to change"],
    ]);
    expect(fake.calls.updates.filter((w) => w.table === "folders")).toHaveLength(0);
  });

  it("merges newly applied indexes into the originating message, scoped to the caller", async () => {
    seedFolder();
    fake.seed("folder_chat_messages", [
      {
        id: MESSAGE,
        folder_id: FOLDER,
        user_id: TEST_USER,
        role: "assistant",
        content: "proposal",
        applied_action_indexes: [2, 0],
      },
    ]);

    await applyFolderChanges({
      data: {
        folder_id: FOLDER,
        actions: [{ type: "update_folder_rule", ai_rule: "x", why: "" }],
        message_id: MESSAGE,
        applied_indexes: [1, 0],
      },
    });

    const updates = fake.calls.updates.filter((w) => w.table === "folder_chat_messages");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload).toStrictEqual({ applied_action_indexes: [0, 1, 2] });
    const read = fake.calls.selects.find((s) => s.table === "folder_chat_messages");
    expect(read?.filters).toStrictEqual([
      { op: "eq", col: "id", value: MESSAGE, extra: undefined },
      { op: "eq", col: "folder_id", value: FOLDER, extra: undefined },
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
    ]);
  });

  it("does not record applied indexes when every action failed", async () => {
    seedFolder();
    fake.onUpdate("folders", () => ({ message: "nope" }));

    const result = await applyFolderChanges({
      data: {
        folder_id: FOLDER,
        actions: [{ type: "update_folder_rule", ai_rule: "x", why: "" }],
        message_id: MESSAGE,
        applied_indexes: [0],
      },
    });

    expect(result.results.map((r) => r.ok)).toStrictEqual([false]);
    expect(fake.calls.updates.filter((w) => w.table === "folder_chat_messages")).toHaveLength(0);
  });
});
