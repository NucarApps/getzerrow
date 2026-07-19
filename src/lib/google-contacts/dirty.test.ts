import { describe, expect, it } from "vitest";
import { isLocalGoogleContactDirty } from "./dirty";

describe("isLocalGoogleContactDirty", () => {
  it("treats unsynced linked contacts as dirty", () => {
    expect(isLocalGoogleContactDirty("2026-07-18T12:00:00.000Z", null)).toBe(true);
  });

  it("treats contacts updated after the last Google sync as dirty", () => {
    expect(isLocalGoogleContactDirty("2026-07-18T12:00:01.000Z", "2026-07-18T12:00:00.000Z")).toBe(
      true,
    );
  });

  it("treats contacts updated before or at the last Google sync as clean", () => {
    expect(isLocalGoogleContactDirty("2026-07-18T12:00:00.000Z", "2026-07-18T12:00:00.000Z")).toBe(
      false,
    );
    expect(isLocalGoogleContactDirty("2026-07-18T11:59:59.000Z", "2026-07-18T12:00:00.000Z")).toBe(
      false,
    );
  });
});
