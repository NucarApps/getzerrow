import { describe, it, expect } from "vitest";
import { SKIP_REASON_LABEL, skipReasonLabel } from "./meeting-skip-reason";

/**
 * Every value `resolveRecordingPlan` can assign to `skipReason`, in the
 * precedence order it tries them (meetings-autojoin.server.ts). This list is
 * the contract the label map has to satisfy.
 */
const SERVER_REASONS = [
  "no_link",
  "auto_record_off",
  "declined",
  "color",
  "off",
  "in_person",
  "blocked",
] as const;

describe("skipReasonLabel", () => {
  it.each([
    ["no_link", "No video link"],
    ["auto_record_off", "Auto-record off"],
    ["declined", "Declined"],
    ["color", "Event color turned off"],
    ["off", "Turned off"],
    ["in_person", "Recording in person"],
    ["blocked", "Blocked contact"],
  ])("explains %s as %s", (reason, label) => {
    expect(skipReasonLabel(reason)).toBe(label);
  });

  it("falls back to a bare 'Not recorded' when there is no reason at all", () => {
    expect(skipReasonLabel(null)).toBe("Not recorded");
    expect(skipReasonLabel(undefined)).toBe("Not recorded");
    expect(skipReasonLabel("")).toBe("Not recorded");
  });

  it("falls back rather than showing a raw slug for an unknown reason", () => {
    expect(skipReasonLabel("some_future_reason")).toBe("Not recorded");
  });

  // A plain-object lookup answers inherited keys, so without an own-property
  // check "toString" resolves to a function that sails past the ?? and is
  // handed to React as a child.
  it("does not treat an inherited Object property as a label", () => {
    expect(skipReasonLabel("toString")).toBe("Not recorded");
    expect(skipReasonLabel("constructor")).toBe("Not recorded");
  });

  it("has copy for every reason the server can emit, so none reads as a bare fallback", () => {
    const unlabelled = SERVER_REASONS.filter((r) => SKIP_REASON_LABEL[r] === undefined);
    expect(unlabelled).toStrictEqual([]);
    for (const reason of SERVER_REASONS) {
      expect(skipReasonLabel(reason)).not.toBe("Not recorded");
    }
  });

  it("has no label copy that no server reason can produce", () => {
    const known = new Set<string>(SERVER_REASONS);
    expect(Object.keys(SKIP_REASON_LABEL).filter((k) => !known.has(k))).toStrictEqual([]);
  });
});
