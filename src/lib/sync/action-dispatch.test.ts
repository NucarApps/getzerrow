// Action fan-out (rules upgrade, task 4). The contracts protected:
//
//   * flag→synthetic mapping preserves the pre-dispatcher Gmail batching
//     order (label → UNREAD → STARRED → INBOX),
//   * an explicit folder_actions row overrides the folder flag for its
//     action type,
//   * every handler is idempotent — an action whose end-state already
//     holds contributes nothing and reports 'skipped',
//   * explicit rows patch the emails row even when persistFlags=false
//     (their effects are never folded into the insert),
//   * delayed explicit actions enqueue into scheduled_actions ('pending')
//     instead of running inline,
//   * unimplemented action types yield an 'error' outcome without
//     breaking the other actions,
//   * applyFolderActions still issues ONE modifyMessage and ONE row
//     update for a folder with explicit rows.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

const modifyMessage = vi.fn(async (..._args: unknown[]) => ({}));
const sendMessage = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../gmail.server", () => ({
  getMessage: async () => ({}),
  parseMessage: () => ({}),
  modifyMessage: (...args: unknown[]) => modifyMessage(...args),
  sendMessage: (...args: unknown[]) => sendMessage(...args),
}));

vi.mock("./classify", () => ({
  classifyByRules: () => ({}),
  classifyByAi: async () => ({}),
  applySurfaceRule: async () => ({ surface: false, reason: "" }),
}));
vi.mock("./encrypted-writer", () => ({
  upsertEmailEncrypted: async () => ({ id: "email-1", error: null }),
  updateEmailEncrypted: async () => ({ error: null }),
}));
vi.mock("./folder-learn", () => ({ bumpEmailsSinceLearn: async () => {} }));
vi.mock("../push.server", () => ({ notifyInboxMail: async () => {} }));
vi.mock("./account-context", () => ({ loadAccountContext: async () => ({}) }));
vi.mock("./executed-rules", () => ({ recordExecution: async () => {} }));

import { dispatchFolderActions, mergeFlagActions, type FolderActionRow } from "./action-dispatch";
import { applyFolderActions, type ActionFolder } from "./process-message";

function actionFolder(over: Partial<ActionFolder> = {}): ActionFolder {
  return {
    id: "folder-A",
    gmail_label_id: null,
    auto_archive: false,
    auto_mark_read: false,
    auto_star: false,
    hide_from_inbox: false,
    forward_to: null,
    snooze_hours: 0,
    ...over,
  };
}

function explicitRow(over: Partial<FolderActionRow> = {}): FolderActionRow {
  return {
    id: "act-1",
    action_type: "archive",
    label_id: null,
    move_to_folder_id: null,
    delay_minutes: 0,
    ...over,
  };
}

function dispatch(
  actions: FolderActionRow[],
  over: Partial<Parameters<typeof dispatchFolderActions>[0]> = {},
) {
  return dispatchFolderActions({
    actions,
    parsed: { raw_labels: ["INBOX", "UNREAD"] },
    inInbox: true,
    persistFlags: true,
    emailRowId: "email-1",
    userId: "user-1",
    ...over,
  });
}

beforeEach(() => {
  fake.reset();
  modifyMessage.mockClear();
  sendMessage.mockClear();
});

describe("mergeFlagActions", () => {
  it("maps folder flags to synthetic actions in Gmail-batching order", () => {
    const merged = mergeFlagActions(
      actionFolder({
        gmail_label_id: "L-A",
        auto_mark_read: true,
        auto_star: true,
        auto_archive: true,
      }),
      [],
    );
    expect(merged.map((a) => a.action_type)).toEqual(["label", "mark_read", "star", "archive"]);
    expect(merged.every((a) => a.id === null)).toBe(true);
    expect(merged[0].label_id).toBe("L-A");
  });

  it("hide_from_inbox maps to archive exactly like auto_archive", () => {
    const merged = mergeFlagActions(actionFolder({ hide_from_inbox: true }), []);
    expect(merged.map((a) => a.action_type)).toEqual(["archive"]);
  });

  it("an explicit row overrides the folder flag for its action type", () => {
    const explicit = explicitRow({ action_type: "label", label_id: "L-CUSTOM" });
    const merged = mergeFlagActions(actionFolder({ gmail_label_id: "L-A" }), [explicit]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "act-1", label_id: "L-CUSTOM" });
  });
});

describe("archive", () => {
  it("removes INBOX and patches is_archived when in the inbox", async () => {
    const { plan, outcomes } = await dispatch([explicitRow()]);
    expect(plan.removeLabels).toEqual(["INBOX"]);
    expect(plan.patch.is_archived).toBe(true);
    expect(outcomes[0]).toMatchObject({ action_type: "archive", status: "applied" });
  });

  it("is a no-op (skipped) when already archived", async () => {
    const { plan, outcomes } = await dispatch([explicitRow()], {
      inInbox: false,
      parsed: { raw_labels: ["UNREAD"] },
    });
    expect(plan.removeLabels).toEqual([]);
    expect(plan.patch).toEqual({});
    expect(outcomes[0].status).toBe("skipped");
  });

  it("running the same action twice contributes one mutation", async () => {
    const { plan, outcomes } = await dispatch([explicitRow(), explicitRow({ id: "act-2" })]);
    expect(plan.removeLabels).toEqual(["INBOX"]);
    expect(outcomes.map((o) => o.status)).toEqual(["applied", "skipped"]);
  });
});

describe("mark_read", () => {
  it("removes UNREAD when present and patches is_read", async () => {
    const { plan } = await dispatch([explicitRow({ action_type: "mark_read" })]);
    expect(plan.removeLabels).toEqual(["UNREAD"]);
    expect(plan.patch.is_read).toBe(true);
  });

  it("skips entirely when already read and already patched", async () => {
    const { plan, outcomes } = await dispatch(
      [
        explicitRow({ action_type: "mark_read" }),
        explicitRow({ id: "a2", action_type: "mark_read" }),
      ],
      { parsed: { raw_labels: ["INBOX"] } },
    );
    // First run still converges local state; the second is a pure no-op.
    expect(plan.removeLabels).toEqual([]);
    expect(outcomes[1].status).toBe("skipped");
  });
});

describe("star", () => {
  it("adds STARRED only when absent", async () => {
    const { plan } = await dispatch([explicitRow({ action_type: "star" })]);
    expect(plan.addLabels).toEqual(["STARRED"]);
    const already = await dispatch([explicitRow({ action_type: "star" })], {
      parsed: { raw_labels: ["INBOX", "STARRED"] },
    });
    expect(already.plan.addLabels).toEqual([]);
    expect(already.outcomes[0].status).toBe("skipped");
  });
});

describe("label", () => {
  it("adds the configured label and reports it in the payload", async () => {
    const { plan, outcomes } = await dispatch([
      explicitRow({ action_type: "label", label_id: "L-X" }),
    ]);
    expect(plan.addLabels).toEqual(["L-X"]);
    expect(outcomes[0].payload).toEqual({ label_id: "L-X" });
  });

  it("skips when the label is already on the message or unset", async () => {
    const present = await dispatch([explicitRow({ action_type: "label", label_id: "L-X" })], {
      parsed: { raw_labels: ["L-X"] },
    });
    expect(present.outcomes[0].status).toBe("skipped");
    const unset = await dispatch([explicitRow({ action_type: "label", label_id: null })]);
    expect(unset.outcomes[0].status).toBe("skipped");
  });
});

describe("move_folder", () => {
  it("patches folder_id and applies the target folder's Gmail label", async () => {
    const { plan, outcomes } = await dispatch(
      [explicitRow({ action_type: "move_folder", move_to_folder_id: "folder-B" })],
      { resolveMoveTarget: async () => ({ gmail_label_id: "L-B" }) },
    );
    expect(plan.patch.folder_id).toBe("folder-B");
    expect(plan.addLabels).toEqual(["L-B"]);
    expect(outcomes[0]).toMatchObject({
      status: "applied",
      payload: { move_to_folder_id: "folder-B" },
    });
  });

  it("skips without a target and dedupes a repeated move", async () => {
    const noTarget = await dispatch([explicitRow({ action_type: "move_folder" })]);
    expect(noTarget.outcomes[0].status).toBe("skipped");
    const twice = await dispatch([
      explicitRow({ action_type: "move_folder", move_to_folder_id: "folder-B" }),
      explicitRow({ id: "a2", action_type: "move_folder", move_to_folder_id: "folder-B" }),
    ]);
    expect(twice.outcomes.map((o) => o.status)).toEqual(["applied", "skipped"]);
  });
});

describe("delayed actions", () => {
  it("enqueues into scheduled_actions instead of running inline", async () => {
    const before = Date.now();
    const { plan, outcomes } = await dispatch([explicitRow({ delay_minutes: 30 })]);
    expect(plan.removeLabels).toEqual([]);
    expect(outcomes[0].status).toBe("pending");
    const inserts = fake.calls.inserts.filter((i) => i.table === "scheduled_actions");
    expect(inserts).toHaveLength(1);
    const row = inserts[0].payload as { user_id: string; run_at: string };
    expect(row.user_id).toBe("user-1");
    expect(Date.parse(row.run_at)).toBeGreaterThanOrEqual(before + 29 * 60_000);
  });

  it("reports an error when user context is missing", async () => {
    const { outcomes } = await dispatch([explicitRow({ delay_minutes: 30 })], {
      userId: undefined,
    });
    expect(outcomes[0].status).toBe("error");
    expect(fake.calls.inserts.filter((i) => i.table === "scheduled_actions")).toHaveLength(0);
  });
});

describe("unimplemented types + synthetic patch gating", () => {
  it("reports 'error' for not-yet-implemented types without breaking the rest", async () => {
    const { plan, outcomes } = await dispatch([
      explicitRow({ action_type: "reply" }),
      explicitRow({ id: "a2", action_type: "archive" }),
    ]);
    expect(outcomes[0]).toMatchObject({ action_type: "reply", status: "error" });
    expect(outcomes[0].error).toContain("not implemented");
    expect(outcomes[1].status).toBe("applied");
    expect(plan.removeLabels).toEqual(["INBOX"]);
  });

  it("synthetic actions skip the patch when persistFlags=false; explicit rows never do", async () => {
    const synthetic = mergeFlagActions(actionFolder({ auto_archive: true }), []);
    const syntheticRun = await dispatch(synthetic, { persistFlags: false });
    expect(syntheticRun.plan.removeLabels).toEqual(["INBOX"]);
    expect(syntheticRun.plan.patch).toEqual({});

    const explicitRun = await dispatch([explicitRow()], { persistFlags: false });
    expect(explicitRun.plan.patch.is_archived).toBe(true);
  });
});

describe("applyFolderActions with explicit rows (integration)", () => {
  it("explicit label row overrides the folder's gmail_label_id and patches on insert path", async () => {
    fake.seed("folder_actions", [
      {
        id: "act-9",
        folder_id: "folder-A",
        action_type: "label",
        label_id: "L-OVERRIDE",
        move_to_folder_id: null,
        delay_minutes: 0,
        enabled: true,
      },
    ]);
    const parsed = {
      raw_labels: ["INBOX", "UNREAD"],
      subject: "s",
      from_addr: "a@x.com",
      from_name: "A",
      received_at: new Date().toISOString(),
      body_text: "b",
      snippet: "sn",
    };
    const outcomes = await applyFolderActions(
      "acc-1",
      "gm-1",
      "email-1",
      actionFolder({ gmail_label_id: "L-FLAG", auto_archive: true }),
      parsed,
      true,
      { persistFlags: false, userId: "user-1" },
    );
    // One Gmail call: override label + archive (flag) — no L-FLAG.
    expect(modifyMessage).toHaveBeenCalledTimes(1);
    expect(modifyMessage).toHaveBeenCalledWith("acc-1", "gm-1", ["L-OVERRIDE"], ["INBOX"]);
    // Explicit label has no row patch; synthetic archive skips its patch
    // under persistFlags=false → no emails update at all.
    expect(fake.calls.updates.filter((u) => u.table === "emails")).toHaveLength(0);
    expect(outcomes.map((o) => [o.action_type, o.status])).toEqual([
      ["label", "applied"],
      ["archive", "applied"],
    ]);
  });
});
