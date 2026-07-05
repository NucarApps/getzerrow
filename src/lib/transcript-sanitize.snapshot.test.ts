import { describe, it, expect } from "vitest";
import { collapseRunawayRepeats } from "./transcript-sanitize";

// Golden-output regression guard for the STT transcript sanitizer.
//
// These inline snapshots pin the EXACT string `collapseRunawayRepeats` produces
// for a set of representative inputs (STT hallucination loops plus normal
// speech). If a change to the sanitizer alters any output, this test fails in
// CI, forcing a deliberate review + snapshot update rather than a silent
// behavior change.
//
// Run locally to intentionally update after a reviewed change:
//   bun run test:meetings-transcript:update

const REPEAT = (block: string, times: number) => block.repeat(times).trim();

describe("transcript sanitizer — golden output regression", () => {
  it("collapses an alternating two-sentence loop (the iOS bug pattern)", () => {
    const input = REPEAT("Why are we doing this later? Okay, hold on. ", 24);
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(
      `"Why are we doing this later? Okay, hold on."`,
    );
  });

  it("collapses a single sentence repeated many times", () => {
    const input = REPEAT("Thank you. ", 30);
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(`"Thank you."`);
  });

  it("collapses a three-sentence block loop", () => {
    const input = REPEAT("First point. Second point. Third point. ", 10);
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(
      `"First point. Second point. Third point."`,
    );
  });

  it("leaves a normal transcript untouched", () => {
    const input =
      "Let's start the meeting. First we reviewed the roadmap. Then we agreed on next steps. " +
      "Sarah will send the notes. Thanks everyone.";
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(
      `"Let's start the meeting. First we reviewed the roadmap. Then we agreed on next steps. Sarah will send the notes. Thanks everyone."`,
    );
  });

  it("keeps a genuine double emphasis (below the loop threshold)", () => {
    const input = "No. No. That is not what we agreed on.";
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(
      `"No. No. That is not what we agreed on."`,
    );
  });

  it("collapses a leading loop while preserving the real tail", () => {
    const input = REPEAT("Can you hear me? ", 12) + "Okay great, let's begin the review.";
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(
      `"Can you hear me? Okay great, let's begin the review."`,
    );
  });
});
