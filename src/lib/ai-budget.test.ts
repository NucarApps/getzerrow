// remainingAttemptTimeout governs the classify cascade: each model
// attempt gets min(attempt cap, time left), and the cascade short-
// circuits (null) when less than 500ms of total budget remains.
import { describe, it, expect } from "vitest";
import { remainingAttemptTimeout } from "./ai-budget";

describe("remainingAttemptTimeout", () => {
  const now = 1_000_000;

  it("returns the attempt cap when plenty of budget remains", () => {
    expect(remainingAttemptTimeout(now + 18_000, 7_000, now)).toBe(7_000);
  });

  it("clamps to the remaining budget when it is below the attempt cap", () => {
    expect(remainingAttemptTimeout(now + 3_000, 7_000, now)).toBe(3_000);
  });

  it("returns null when less than 500ms remains", () => {
    expect(remainingAttemptTimeout(now + 499, 7_000, now)).toBeNull();
  });

  it("returns exactly 500 at the threshold", () => {
    expect(remainingAttemptTimeout(now + 500, 7_000, now)).toBe(500);
  });

  it("returns null when the deadline has passed", () => {
    expect(remainingAttemptTimeout(now - 1, 7_000, now)).toBeNull();
  });
});
