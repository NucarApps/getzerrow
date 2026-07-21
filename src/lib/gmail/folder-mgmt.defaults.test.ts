import { describe, expect, it } from "vitest";
import { deriveFolderAiDefaults } from "./folder-mgmt.functions";

describe("deriveFolderAiDefaults", () => {
  it("mirrors-only when the folder is linked to an existing Gmail label", () => {
    expect(deriveFolderAiDefaults("Label_27")).toEqual({
      skip_ai: true,
      min_ai_confidence: 0.75,
    });
  });

  it("keeps AI on when the folder has no Gmail label", () => {
    expect(deriveFolderAiDefaults(null)).toEqual({
      skip_ai: false,
      min_ai_confidence: 0,
    });
    expect(deriveFolderAiDefaults(undefined)).toEqual({
      skip_ai: false,
      min_ai_confidence: 0,
    });
  });
});
