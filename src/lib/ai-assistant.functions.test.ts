// Unit tests for the inbox assistant server functions
// (src/lib/ai-assistant.functions.ts). Contracts pinned here:
//
//   - proposeAssistantChanges verifies the gmail account belongs to the
//     caller before the model is called, and every context read it then
//     issues is scoped to that user AND that account;
//   - applyAssistantChanges pre-verifies ownership of every referenced
//     folder, filter and email, so a proposal naming a foreign id fails
//     that one action without writing anything;
//   - move_matching builds its ILIKE pattern through escapeLike (a value
//     containing % or _ must not widen the match) and is capped at
//     MOVE_MATCHING_CAP moves.
//
// Harness: __fixtures__/server-fn-stub + __fixtures__/supabase-fake.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";
import type { AssistantProposal } from "./ai-assistant.server";

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

const { proposeAi, performMove, getEmailsDecrypted } = vi.hoisted(() => ({
  proposeAi: vi.fn<typeof import("./ai-assistant.server").proposeAssistantChanges>(),
  performMove: vi.fn<typeof import("./move-email.server").performMove>(),
  getEmailsDecrypted: vi.fn<typeof import("./sync/encrypted-reader").getEmailsDecrypted>(),
}));
vi.mock("./ai-assistant.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai-assistant.server")>();
  return { ...actual, proposeAssistantChanges: proposeAi };
});
vi.mock("./move-email.server", () => ({ performMove }));
vi.mock("./sync/encrypted-reader", () => ({ getEmailsDecrypted }));

import { applyAssistantChanges, proposeAssistantChanges } from "./ai-assistant.functions";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const FOLDER = "22222222-2222-4222-8222-222222222222";
const FOREIGN_FOLDER = "33333333-3333-4333-8333-333333333333";
const EMAIL = "44444444-4444-4444-8444-444444444444";
const FOREIGN_EMAIL = "55555555-5555-4555-8555-555555555555";
const FILTER = "66666666-6666-4666-8666-666666666666";
const FOREIGN_FILTER = "77777777-7777-4777-8777-777777777777";
const ATTACKER = "attacker-user";
const VICTIM = "victim-user";

function proposal(overrides?: Partial<AssistantProposal>): AssistantProposal {
  return { reply: "ok", clarifying_question: "", actions: [], ...overrides };
}

function seedAccount(ownerId: string = TEST_USER) {
  fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: ownerId }]);
}

function seedFolders() {
  fake.seed("folders", [
    {
      id: FOLDER,
      user_id: TEST_USER,
      gmail_account_id: ACCOUNT,
      name: "Clients",
      ai_rule: "client mail",
      learned_profile: null,
    },
    {
      id: FOREIGN_FOLDER,
      user_id: VICTIM,
      gmail_account_id: ACCOUNT,
      name: "Victim",
      ai_rule: null,
      learned_profile: null,
    },
  ]);
}

beforeEach(() => {
  fake.reset();
  proposeAi.mockResolvedValue(proposal());
  performMove.mockResolvedValue({ ok: true });
  getEmailsDecrypted.mockResolvedValue({ rows: [], error: null });
});

describe("proposeAssistantChanges", () => {
  it("denies another user's gmail account before the model is called", async () => {
    seedAccount();
    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(
          proposeAssistantChanges,
          ATTACKER,
        )({
          data: {
            gmail_account_id: ACCOUNT,
            user_message: "file these",
            history: [],
            selected_email_ids: [],
          },
        }),
      rejects: "Gmail account not found",
    });
    expect(proposeAi, "a cross-tenant prompt must never reach the model").not.toHaveBeenCalled();
  });

  it("rejects an account id that does not exist", async () => {
    await expect(
      proposeAssistantChanges({
        data: {
          gmail_account_id: ACCOUNT,
          user_message: "hi",
          history: [],
          selected_email_ids: [],
        },
      }),
    ).rejects.toThrow("Gmail account not found");
    expect(writeCount(fake)).toBe(0);
  });

  it("feeds the model only this user's folders, selected emails and domain clusters", async () => {
    seedAccount();
    seedFolders();
    fake.seed("folder_filters", [
      { id: FILTER, folder_id: FOLDER, field: "domain", op: "equals", value: "acme.com" },
      {
        id: FOREIGN_FILTER,
        folder_id: FOREIGN_FOLDER,
        field: "domain",
        op: "equals",
        value: "secret.com",
      },
    ]);
    fake.seed("emails", [
      {
        id: EMAIL,
        user_id: TEST_USER,
        gmail_account_id: ACCOUNT,
        from_addr: "a@acme.com",
        folder_id: null,
        in_reply_to: "<parent>",
        list_id: null,
        received_at: "2026-01-02T00:00:00Z",
      },
      {
        id: "88888888-8888-4888-8888-888888888888",
        user_id: TEST_USER,
        gmail_account_id: ACCOUNT,
        from_addr: "b@acme.com",
        folder_id: FOLDER,
        in_reply_to: null,
        list_id: null,
        received_at: "2026-01-01T00:00:00Z",
      },
      {
        id: FOREIGN_EMAIL,
        user_id: VICTIM,
        gmail_account_id: ACCOUNT,
        from_addr: "v@victim.com",
        folder_id: null,
        in_reply_to: null,
        list_id: null,
        received_at: "2026-01-03T00:00:00Z",
      },
    ]);
    getEmailsDecrypted.mockResolvedValue({
      rows: [
        {
          id: EMAIL,
          subject: "Invoice",
          snippet: "please pay",
          from_name: "Acme",
          classification_reason: "rule",
        },
      ] as unknown as Awaited<ReturnType<typeof getEmailsDecrypted>>["rows"],
      error: null,
    });

    await proposeAssistantChanges({
      data: {
        gmail_account_id: ACCOUNT,
        user_message: "why is acme mail not in Clients?",
        history: [{ role: "user", content: "earlier" }],
        selected_email_ids: [EMAIL, FOREIGN_EMAIL],
      },
    });

    const arg = proposeAi.mock.calls[0]?.[0];
    expect(arg?.folders).toStrictEqual([
      {
        id: FOLDER,
        name: "Clients",
        ai_rule: "client mail",
        learned_profile: null,
        filters: [{ id: FILTER, field: "domain", op: "equals", value: "acme.com" }],
      },
    ]);
    expect(arg?.emails).toStrictEqual([
      {
        id: EMAIL,
        from_addr: "a@acme.com",
        from_name: "Acme",
        subject: "Invoice",
        snippet: "please pay",
        folder_id: null,
        domain: "acme.com",
        is_reply: true,
        list_id: null,
        classification_reason: "rule",
      },
    ]);
    expect(arg?.domainClusters).toStrictEqual([
      {
        domain: "acme.com",
        count: 2,
        folders: [
          { name: "Inbox", count: 1 },
          { name: "Clients", count: 1 },
        ],
      },
    ]);
    // The message names "Clients", so that folder's recent mail is sampled.
    expect(arg?.folderSample?.folderId).toBe(FOLDER);
    expect(arg?.folderSample?.folderName).toBe("Clients");
    expect(writeCount(fake)).toBe(0);
  });

  it("surfaces a model failure rather than returning an empty proposal", async () => {
    seedAccount();
    proposeAi.mockRejectedValue(new Error("gateway down"));

    await expect(
      proposeAssistantChanges({
        data: {
          gmail_account_id: ACCOUNT,
          user_message: "hi",
          history: [],
          selected_email_ids: [],
        },
      }),
    ).rejects.toThrow("gateway down");
  });
});

describe("applyAssistantChanges", () => {
  it("refuses to move an email into another user's folder", async () => {
    seedFolders();
    fake.seed("emails", [{ id: EMAIL, user_id: TEST_USER }]);

    const result = await applyAssistantChanges({
      data: {
        actions: [{ type: "move_email", email_id: EMAIL, to_folder_id: FOREIGN_FOLDER, why: "" }],
      },
    });

    expect(result.results.map((r) => [r.ok, r.error])).toStrictEqual([[false, "Folder not owned"]]);
    expect(performMove).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("refuses to move another user's email into the caller's folder", async () => {
    seedFolders();
    fake.seed("emails", [{ id: FOREIGN_EMAIL, user_id: VICTIM }]);

    const result = await applyAssistantChanges({
      data: {
        actions: [{ type: "move_email", email_id: FOREIGN_EMAIL, to_folder_id: FOLDER, why: "" }],
      },
    });

    expect(result.results.map((r) => [r.ok, r.error])).toStrictEqual([[false, "Email not owned"]]);
    expect(performMove).not.toHaveBeenCalled();
  });

  it("refuses to remove a filter belonging to another user's folder", async () => {
    fake.seedRaw("folder_filters", [
      { id: FOREIGN_FILTER, folder_id: FOREIGN_FOLDER, folders: { user_id: VICTIM } },
    ]);

    const result = await applyAssistantChanges({
      data: { actions: [{ type: "remove_filter", filter_id: FOREIGN_FILTER, why: "" }] },
    });

    expect(result.results.map((r) => [r.ok, r.error])).toStrictEqual([[false, "Filter not owned"]]);
    expect(fake.calls.deletes).toHaveLength(0);
  });

  it("moves an owned email through the single writer and reports success", async () => {
    seedFolders();
    fake.seed("emails", [{ id: EMAIL, user_id: TEST_USER }]);

    const result = await applyAssistantChanges({
      data: { actions: [{ type: "move_email", email_id: EMAIL, to_folder_id: FOLDER, why: "" }] },
    });

    expect(result.results.map((r) => r.ok)).toStrictEqual([true]);
    expect(performMove.mock.calls).toStrictEqual([[TEST_USER, EMAIL, FOLDER]]);
  });

  it("reports a writer refusal as a per-action failure", async () => {
    seedFolders();
    fake.seed("emails", [{ id: EMAIL, user_id: TEST_USER }]);
    performMove.mockResolvedValue({ ok: false, error: "folder is paused" });

    const result = await applyAssistantChanges({
      data: { actions: [{ type: "move_email", email_id: EMAIL, to_folder_id: FOLDER, why: "" }] },
    });

    expect(result.results.map((r) => [r.ok, r.error])).toStrictEqual([[false, "folder is paused"]]);
  });

  it("escapes LIKE metacharacters in a move_matching from pattern", async () => {
    seedFolders();

    await applyAssistantChanges({
      data: {
        actions: [
          {
            type: "move_matching",
            field: "from",
            op: "contains",
            value: "50%_OFF",
            to_folder_id: FOLDER,
            why: "",
          },
        ],
      },
    });

    const scan = fake.calls.selects.find((s) => s.filters.some((f) => f.op === "ilike"));
    expect(scan?.filters).toStrictEqual([
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
      { op: "ilike", col: "from_addr", value: "%50\\%\\_off%", extra: undefined },
    ]);
  });

  it("anchors a move_matching domain equals pattern to the address host", async () => {
    seedFolders();

    await applyAssistantChanges({
      data: {
        actions: [
          {
            type: "move_matching",
            field: "domain",
            op: "equals",
            value: "@Acme.com",
            to_folder_id: FOLDER,
            why: "",
          },
        ],
      },
    });

    const scan = fake.calls.selects.find((s) => s.filters.some((f) => f.op === "ilike"));
    expect(scan?.filters.find((f) => f.op === "ilike")?.value).toBe("%@acme.com");
  });

  it("moves at most MOVE_MATCHING_CAP existing emails for one action", async () => {
    seedFolders();
    fake.seed(
      "emails",
      Array.from({ length: 250 }, (_, i) => ({
        id: `e-${i}`,
        user_id: TEST_USER,
        from_addr: `s${i}@acme.com`,
        received_at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
      })),
    );

    const result = await applyAssistantChanges({
      data: {
        actions: [
          {
            type: "move_matching",
            field: "domain",
            op: "equals",
            value: "acme.com",
            to_folder_id: FOLDER,
            why: "",
          },
        ],
      },
    });

    expect(result.results.map((r) => r.ok)).toStrictEqual([true]);
    expect(performMove).toHaveBeenCalledTimes(200);
  });

  it("succeeds with no moves when a move_matching signal matches nothing", async () => {
    seedFolders();
    fake.seed("emails", [{ id: EMAIL, user_id: TEST_USER, from_addr: "someone@other.com" }]);

    const result = await applyAssistantChanges({
      data: {
        actions: [
          {
            type: "move_matching",
            field: "domain",
            op: "equals",
            value: "acme.com",
            to_folder_id: FOLDER,
            why: "",
          },
        ],
      },
    });

    expect(result.results.map((r) => r.ok)).toStrictEqual([true]);
    expect(performMove).not.toHaveBeenCalled();
  });

  it("inserts a normalized filter on an owned folder and dedupes an identical one", async () => {
    seedFolders();

    const first = await applyAssistantChanges({
      data: {
        actions: [
          {
            type: "add_filter",
            folder_id: FOLDER,
            field: "domain",
            op: "equals",
            value: " @ACME.com ",
            why: "",
          },
        ],
      },
    });
    expect(first.results.map((r) => r.ok)).toStrictEqual([true]);
    expect(fake.calls.inserts.map((w) => w.payload)).toStrictEqual([
      { folder_id: FOLDER, field: "domain", op: "equals", value: "acme.com" },
    ]);

    fake.seed("folder_filters", [
      { id: FILTER, folder_id: FOLDER, field: "domain", op: "equals", value: "acme.com" },
    ]);
    const second = await applyAssistantChanges({
      data: {
        actions: [
          {
            type: "add_filter",
            folder_id: FOLDER,
            field: "domain",
            op: "equals",
            value: "acme.com",
            why: "",
          },
        ],
      },
    });
    expect(second.results.map((r) => r.ok)).toStrictEqual([true]);
    expect(fake.calls.inserts).toHaveLength(1);
  });

  it("isolates a failing action so later actions still apply", async () => {
    seedFolders();
    fake.onUpdate("folders", (payload) =>
      (payload as { ai_rule?: string }).ai_rule ? { message: "rule write failed" } : null,
    );

    const result = await applyAssistantChanges({
      data: {
        actions: [
          { type: "update_folder_rule", folder_id: FOLDER, ai_rule: "  x  ", why: "" },
          {
            type: "update_folder_profile",
            folder_id: FOLDER,
            learned_profile: "  they invoice monthly  ",
            why: "",
          },
        ],
      },
    });

    expect(result.results.map((r) => [r.ok, r.error])).toStrictEqual([
      [false, "rule write failed"],
      [true, undefined],
    ]);
    const updates = fake.calls.updates.filter((w) => w.table === "folders");
    expect(updates[1]?.payload).toStrictEqual({ learned_profile: "they invoice monthly" });
    expect(updates[1]?.filters).toStrictEqual([
      { op: "eq", col: "id", value: FOLDER, extra: undefined },
    ]);
  });
});
