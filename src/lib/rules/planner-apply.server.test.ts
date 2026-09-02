// applyMoves (src/lib/rules/planner-apply.server.ts) — audit path 13.
//
// The planner previews a rule change and then applies it in bulk. It files
// through the same destructive core as a manual move (performMove /
// restoreEmailToInbox), so what this suite pins is the part it owns: the
// three refusals, the to-Inbox branch, and the counts the UI reports.
//
// The refusals matter more than the happy path: `placed_by_user` is the only
// thing standing between a rule edit and overwriting mail the user filed by
// hand, and the ownership check is on the service-role client (no RLS).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const { performMove, restoreEmailToInbox } = vi.hoisted(() => ({
  performMove: vi.fn(
    async (
      _userId: string,
      _emailId: string,
      _toFolderId: string,
      _reason?: string,
    ): Promise<{ ok: boolean; error?: string }> => ({ ok: true }),
  ),
  restoreEmailToInbox: vi.fn(async (_opts: Record<string, unknown>) => {}),
}));
vi.mock("../move-email.server", () => ({ performMove }));
vi.mock("../gmail-helpers.server", () => ({ restoreEmailToInbox }));

import { applyMoves } from "./planner-apply.server";

const USER = "user-1";
const ACC = "acc-1";
const FOLDER = "folder-A";
const OTHER_FOLDER = "folder-B";

function seedEmail(over: Record<string, unknown> = {}) {
  fake.seed("emails", [
    {
      id: "e-1",
      user_id: USER,
      folder_id: FOLDER,
      gmail_message_id: "gm-1",
      gmail_account_id: ACC,
      raw_labels: ["L-A"],
      placed_by_user: false,
      ...over,
    },
  ]);
}

beforeEach(() => {
  fake.reset();
});

describe("refusals (nothing is filed)", () => {
  it("refuses a row that belongs to another user, reporting not_found", async () => {
    seedEmail({ user_id: "someone-else" });
    const res = await applyMoves(USER, [{ email_id: "e-1", to_folder_id: OTHER_FOLDER }]);
    expect(res).toMatchObject({ applied: 0, skipped: 1, failed: 0 });
    expect(res.results[0]).toEqual({ email_id: "e-1", ok: false, skipped: "not_found" });
    expect(performMove).not.toHaveBeenCalled();
    expect(restoreEmailToInbox).not.toHaveBeenCalled();
  });

  it("refuses a row that does not exist at all", async () => {
    const res = await applyMoves(USER, [{ email_id: "missing", to_folder_id: OTHER_FOLDER }]);
    expect(res.results[0]!.skipped).toBe("not_found");
    expect(performMove).not.toHaveBeenCalled();
  });

  it("refuses hand-placed mail: placed_by_user beats the rule", async () => {
    seedEmail({ placed_by_user: true });
    const res = await applyMoves(USER, [{ email_id: "e-1", to_folder_id: OTHER_FOLDER }]);
    expect(res).toMatchObject({ applied: 0, skipped: 1, failed: 0 });
    expect(res.results[0]!.skipped).toBe("placed_by_user");
    expect(performMove).not.toHaveBeenCalled();
  });

  it("skips a move that would not change anything", async () => {
    seedEmail();
    const res = await applyMoves(USER, [{ email_id: "e-1", to_folder_id: FOLDER }]);
    expect(res.results[0]!.skipped).toBe("unchanged");
    expect(performMove).not.toHaveBeenCalled();
  });

  it("treats an already-inboxed row moved to the Inbox as unchanged (null === null)", async () => {
    seedEmail({ folder_id: null });
    const res = await applyMoves(USER, [{ email_id: "e-1", to_folder_id: null }]);
    expect(res.results[0]!.skipped).toBe("unchanged");
    expect(restoreEmailToInbox).not.toHaveBeenCalled();
  });
});

describe("filing", () => {
  it("moves through performMove with the planner's reason", async () => {
    seedEmail();
    const res = await applyMoves(USER, [{ email_id: "e-1", to_folder_id: OTHER_FOLDER }]);
    expect(res).toMatchObject({ applied: 1, skipped: 0, failed: 0 });
    expect(performMove).toHaveBeenCalledWith(
      USER,
      "e-1",
      OTHER_FOLDER,
      "Applied from a rule change preview",
    );
  });

  it("reports a failed move as failed, not skipped", async () => {
    seedEmail();
    performMove.mockResolvedValueOnce({ ok: false, error: "gmail down" });
    const res = await applyMoves(USER, [{ email_id: "e-1", to_folder_id: OTHER_FOLDER }]);
    expect(res).toMatchObject({ applied: 0, skipped: 0, failed: 1 });
    expect(res.results[0]).toEqual({ email_id: "e-1", ok: false, error: "gmail down" });
  });

  it("a move to null restores the Inbox with the source folder's label stripped", async () => {
    seedEmail();
    fake.seed("folders", [{ id: FOLDER, gmail_label_id: "L-A" }]);
    const res = await applyMoves(USER, [{ email_id: "e-1", to_folder_id: null }]);
    expect(res).toMatchObject({ applied: 1, skipped: 0, failed: 0 });
    expect(performMove).not.toHaveBeenCalled();
    expect(restoreEmailToInbox).toHaveBeenCalledWith({
      emailId: "e-1",
      gmailAccountId: ACC,
      gmailMessageId: "gm-1",
      currentLabels: ["L-A"],
      fromLabel: "L-A",
      classifiedBy: "rule_replay",
      classificationReason: "Returned to the Inbox by a rule change preview",
      aiConfidence: 1,
      labelFailureLog: { event: "rules.replay.inbox_label_sync_failed" },
    });
  });

  it("restores to the Inbox with no fromLabel when the source folder has no Gmail label", async () => {
    seedEmail();
    fake.seed("folders", [{ id: FOLDER, gmail_label_id: null }]);
    await applyMoves(USER, [{ email_id: "e-1", to_folder_id: null }]);
    expect(restoreEmailToInbox.mock.calls[0]![0]).toMatchObject({ fromLabel: null });
  });

  it("reports a throwing Inbox restore as failed", async () => {
    seedEmail();
    restoreEmailToInbox.mockRejectedValueOnce(new Error("label sync failed"));
    const res = await applyMoves(USER, [{ email_id: "e-1", to_folder_id: null }]);
    expect(res).toMatchObject({ applied: 0, skipped: 0, failed: 1 });
    expect(res.results[0]!.error).toBe("label sync failed");
  });
});

describe("batch accounting", () => {
  it("partitions a mixed batch exhaustively into applied / skipped / failed", async () => {
    fake.seed("emails", [
      {
        id: "ok",
        user_id: USER,
        folder_id: FOLDER,
        gmail_account_id: ACC,
        gmail_message_id: "g1",
        raw_labels: [],
        placed_by_user: false,
      },
      {
        id: "pinned",
        user_id: USER,
        folder_id: FOLDER,
        gmail_account_id: ACC,
        gmail_message_id: "g2",
        raw_labels: [],
        placed_by_user: true,
      },
      {
        id: "theirs",
        user_id: "other",
        folder_id: FOLDER,
        gmail_account_id: ACC,
        gmail_message_id: "g3",
        raw_labels: [],
        placed_by_user: false,
      },
      {
        id: "boom",
        user_id: USER,
        folder_id: FOLDER,
        gmail_account_id: ACC,
        gmail_message_id: "g4",
        raw_labels: [],
        placed_by_user: false,
      },
    ]);
    performMove.mockImplementation(async (_u: string, id: string) =>
      id === "boom" ? { ok: false, error: "nope" } : { ok: true },
    );

    const res = await applyMoves(USER, [
      { email_id: "ok", to_folder_id: OTHER_FOLDER },
      { email_id: "pinned", to_folder_id: OTHER_FOLDER },
      { email_id: "theirs", to_folder_id: OTHER_FOLDER },
      { email_id: "boom", to_folder_id: OTHER_FOLDER },
    ]);

    expect(res).toMatchObject({ applied: 1, skipped: 2, failed: 1 });
    expect(res.results.map((r) => r.email_id)).toEqual(["ok", "pinned", "theirs", "boom"]);
    // Every result is exactly one of ok / skipped / failed.
    for (const r of res.results) {
      expect(r.ok || !!r.skipped || !!r.error, `unclassified result for ${r.email_id}`).toBe(true);
    }
    expect(res.applied + res.skipped + res.failed).toBe(res.results.length);
  });
});
