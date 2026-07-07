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

describe("transcript sanitizer — edge-case golden output", () => {
  it("returns an empty string unchanged", () => {
    expect(collapseRunawayRepeats("")).toMatchInlineSnapshot(`""`);
  });

  it("returns whitespace-only input unchanged", () => {
    expect(collapseRunawayRepeats("   \n  ")).toMatchInlineSnapshot(`
      "   
        "
    `);
  });

  it("collapses a loop that differs only by letter case (case-insensitive match)", () => {
    const input = "Hello there. HELLO THERE. hello there. Hello There. Hello there.";
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(`"Hello there."`);
  });

  it("leaves a 3-unit-total loop intact (guard requires more than 3 units)", () => {
    const input = REPEAT("Sorry, say that again. ", 3);
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(
      `"Sorry, say that again. Sorry, say that again. Sorry, say that again."`,
    );
  });

  it("keeps a block repeated only twice (below the loop threshold)", () => {
    const input = REPEAT("Sorry, say that again. ", 2);
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(
      `"Sorry, say that again. Sorry, say that again."`,
    );
  });

  it("collapses a loop in the middle while preserving surrounding speech", () => {
    const input =
      "Welcome everyone. " + REPEAT("Testing one two. ", 8) + "Let's get to the agenda.";
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(
      `"Welcome everyone. Testing one two. Let's get to the agenda."`,
    );
  });

  it("collapses two distinct back-to-back loops independently", () => {
    const input = REPEAT("Can you hear me? ", 6) + REPEAT("Is this thing on? ", 6);
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(
      `"Can you hear me? Is this thing on?"`,
    );
  });

  it("collapses a two-sentence loop mixing exclamation and question marks", () => {
    const input = REPEAT("Wait! What? ", 15);
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(`"Wait! What?"`);
  });

  it("leaves text with no sentence punctuation unchanged", () => {
    const input = "this has no punctuation and just keeps going without any stops at all";
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(
      `"this has no punctuation and just keeps going without any stops at all"`,
    );
  });

  it("collapses a single short word repeated many times", () => {
    const input = REPEAT("Okay. ", 20);
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(`"Okay."`);
  });

  it("collapses a six-unit block loop (max detectable block size)", () => {
    const input = REPEAT("One. Two. Three. Four. Five. Six. ", 5);
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(
      `"One. Two. Three. Four. Five. Six."`,
    );
  });

  it("collapses a loop separated by newlines", () => {
    const input = REPEAT("Line one.\nLine two.\n", 8);
    expect(collapseRunawayRepeats(input)).toMatchInlineSnapshot(`
      "Line one.
      Line two."
    `);
  });
});
