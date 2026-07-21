import { describe, expect, it } from "vitest";
import { deriveFolderAiDefaults } from "./folder-mgmt.functions";

describe("deriveFolderAiDefaults", () => {
  it("starts every new folder inert (skip_ai=true) regardless of Gmail label linkage", () => {
    // Linked to an existing Gmail label — user is mirroring Gmail-side sort.
    expect(deriveFolderAiDefaults("Label_27")).toEqual({
      skip_ai: true,
      min_ai_confidence: 0.75,
    });
    // Fresh Gmail label created alongside the folder.
    expect(deriveFolderAiDefaults(null)).toEqual({
      skip_ai: true,
      min_ai_confidence: 0.75,
    });
    expect(deriveFolderAiDefaults(undefined)).toEqual({
      skip_ai: true,
      min_ai_confidence: 0.75,
    });
  });
});
