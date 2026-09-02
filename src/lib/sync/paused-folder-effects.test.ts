// A paused folder (processing_enabled=false) is a read-only reflection of
// its linked Gmail label: mail Gmail already labeled still shows up in it,
// but Atzro applies NO side effects — no Gmail label writes, no archive,
// no mark-read, no star, no snooze.
import { describe, it, expect } from "vitest";
import {
  computeFolderEffects,
  computeInsertReadFlag,
  folderProcessingPaused,
  type ActionFolder,
} from "./process-message";

function actionFolder(over: Partial<ActionFolder> = {}): ActionFolder {
  return {
    id: over.id ?? "f1",
    gmail_label_id: over.gmail_label_id ?? "Label_1",
    auto_archive: over.auto_archive ?? true,
    auto_mark_read: over.auto_mark_read ?? true,
    auto_star: over.auto_star ?? true,
    hide_from_inbox: over.hide_from_inbox ?? true,
    forward_to: over.forward_to ?? null,
    snooze_hours: over.snooze_hours ?? 4,
    ...(over.processing_enabled === undefined
      ? {}
      : { processing_enabled: over.processing_enabled }),
  };
}

const parsed = { raw_labels: ["INBOX", "UNREAD"] };

describe("folderProcessingPaused", () => {
  it("treats an absent flag as active (legacy rows)", () => {
    expect(folderProcessingPaused({})).toBe(false);
  });

  it("is paused only when explicitly false", () => {
    expect(folderProcessingPaused({ processing_enabled: false })).toBe(true);
    expect(folderProcessingPaused({ processing_enabled: true })).toBe(false);
  });
});

describe("computeFolderEffects", () => {
  it("applies label + flag effects for an active folder", () => {
    const eff = computeFolderEffects(actionFolder({ processing_enabled: true }), parsed, true);
    expect(eff.effectiveArchive).toBe(true);
    expect(eff.addLabels).toContain("Label_1");
    expect(eff.addLabels).toContain("STARRED");
    expect(eff.removeLabels).toContain("UNREAD");
    expect(eff.removeLabels).toContain("INBOX");
    expect(eff.snoozedUntil).not.toBeNull();
  });

  it("yields an empty plan for a paused folder even with every flag on", () => {
    const eff = computeFolderEffects(actionFolder({ processing_enabled: false }), parsed, true);
    expect(eff.effectiveArchive).toBe(false);
    expect(eff.addLabels).toEqual([]);
    expect(eff.removeLabels).toEqual([]);
    expect(eff.snoozedUntil).toBeNull();
  });

  it("still applies effects when the flag is absent (unmigrated row)", () => {
    const eff = computeFolderEffects(actionFolder(), parsed, true);
    expect(eff.addLabels).toContain("Label_1");
  });
});

describe("computeInsertReadFlag", () => {
  it("marks inserted rows read when active auto mark-read removes UNREAD", () => {
    const eff = computeFolderEffects(actionFolder({ processing_enabled: true }), parsed, true);
    expect(computeInsertReadFlag({ is_read: false }, eff, false)).toBe(true);
  });

  it("keeps unread Gmail-labeled mail unread when the destination folder is paused", () => {
    const eff = computeFolderEffects(actionFolder({ processing_enabled: false }), parsed, true);
    expect(computeInsertReadFlag({ is_read: false }, eff, false)).toBe(false);
  });

  it("preserves Gmail read state while AI is still pending", () => {
    const eff = computeFolderEffects(actionFolder({ processing_enabled: true }), parsed, true);
    expect(computeInsertReadFlag({ is_read: false }, eff, true)).toBe(false);
  });
});

// Guardrail: every place an ActionFolder is built from a cached account
// context must carry processing_enabled through. Dropping the field makes the
// pause guard read "flag absent" and silently re-applies side effects for a
// paused folder, which is exactly the bug this suite exists to prevent. The
// process-message mapper is held to that below; run-jobs' own mapper is held
// to it through runMessageJobs in run-jobs.test.ts ("carries
// processing_enabled through to the ActionFolder").
describe("resolveFolderFromContext", () => {
  it("keeps a paused folder inert end-to-end (mirror only, no effects)", async () => {
    const { resolveFolderFromContext } = await import("./process-message");
    const cached = {
      id: "f1",
      gmail_label_id: "Label_1",
      auto_archive: true,
      auto_mark_read: true,
      auto_star: true,
      hide_from_inbox: true,
      forward_to: null,
      snooze_hours: 4,
      processing_enabled: false,
    };
    // Minimal AccountContext shape: only folders/markReadRules are read here.
    const ctx = { folders: [cached], markReadRules: [] } as unknown as Parameters<
      typeof resolveFolderFromContext
    >[0];
    const folder = resolveFolderFromContext(ctx, "f1", { from_addr: "a@b.com" });
    expect(folder).not.toBeNull();
    expect(folderProcessingPaused(folder!)).toBe(true);
    const eff = computeFolderEffects(folder!, parsed, true);
    expect(eff.addLabels).toEqual([]);
    expect(eff.removeLabels).toEqual([]);
    expect(eff.effectiveArchive).toBe(false);
    expect(eff.snoozedUntil).toBeNull();
  });
});
