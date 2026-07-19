import { describe, it, expect } from "vitest";
import { isUserChosenPhotoSource } from "./photo-source";

describe("isUserChosenPhotoSource", () => {
  it("treats web uploads and legacy carddav saves as user-chosen", () => {
    expect(isUserChosenPhotoSource("user_upload")).toBe(true);
    expect(isUserChosenPhotoSource("carddav")).toBe(true);
  });

  it("treats machine-sourced and unknown photos as replaceable", () => {
    expect(isUserChosenPhotoSource("google")).toBe(false);
    expect(isUserChosenPhotoSource("company_logo")).toBe(false);
    expect(isUserChosenPhotoSource("unknown")).toBe(false);
    expect(isUserChosenPhotoSource(null)).toBe(false);
    expect(isUserChosenPhotoSource(undefined)).toBe(false);
  });
});
