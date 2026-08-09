// A paused folder (processing_enabled=false) is a read-only reflection of
// its linked Gmail label: mail Gmail already labeled still shows up in it,
// but Zerrow applies NO side effects — no Gmail label writes, no archive,
// no mark-read, no star, no snooze.
import { describe, it, expect } from "vitest";
import {
  computeFolderEffects,
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
