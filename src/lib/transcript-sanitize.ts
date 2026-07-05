// Pure, dependency-free transcript sanitization. Kept out of the server module
// so it is trivially unit-testable and reusable.
//
// Speech-to-text models hallucinate into repetition loops when handed audio they
// can't cleanly decode (classically iOS Safari's fragmented MP4). The loop is
// usually not a single stuck sentence but a short *block* of sentences repeating
// over and over, e.g. "Why are we doing this later? Okay, hold on." emitted
// dozens of times. This collapses such runaway blocks back to a single copy
// while leaving normal transcripts untouched.

// Largest repeating block (in sentence-like units) we try to detect.
const MAX_BLOCK_UNITS = 8;
// A block must repeat at least this many times in a row to be treated as a
// hallucination loop (so genuine "No. No." style emphasis survives).
const MIN_REPEATS = 3;

/** Split into sentence-like units, preserving trailing punctuation/whitespace. */
function splitUnits(text: string): string[] | null {
  return text.match(/[^.!?]+[.!?]*\s*/g);
}

/**
 * Collapse runaway repeated phrases produced by STT hallucination loops.
 * Detects a block of 1..N consecutive sentence units repeated MIN_REPEATS+
 * times and keeps a single copy. Returns the input unchanged when no such
 * pathological repetition exists.
 */
export function collapseRunawayRepeats(text: string): string {
  if (!text) return text;
  const parts = splitUnits(text);
  if (!parts || parts.length < MIN_REPEATS + 1) return text;

  const norm = parts.map((p) => p.trim().toLowerCase());
  const n = parts.length;

  const out: string[] = [];
  let i = 0;
  while (i < n) {
    let collapsed = false;
    const maxL = Math.min(MAX_BLOCK_UNITS, Math.floor((n - i) / 2));
    for (let L = 1; L <= maxL; L += 1) {
      // Skip empty/whitespace-only leading units for block matching.
      if (!norm[i]) break;
      let reps = 1;
      for (;;) {
        const start = i + reps * L;
        if (start + L > n) break;
        let same = true;
        for (let k = 0; k < L; k += 1) {
          if (norm[i + k] !== norm[start + k]) {
            same = false;
            break;
          }
        }
        if (!same) break;
        reps += 1;
      }
      if (reps >= MIN_REPEATS) {
        for (let k = 0; k < L; k += 1) out.push(parts[i + k]);
        i += reps * L;
        collapsed = true;
        break;
      }
    }
    if (!collapsed) {
      out.push(parts[i]);
      i += 1;
    }
  }
  return out.join("").trim();
}

/**
 * Report the maximum number of times any sentence unit appears consecutively as
 * part of a repeating block. Used by tests to assert a transcript is free of
 * runaway repetition without hard-coding expected output.
 */
export function maxConsecutiveBlockRepeats(text: string): number {
  const parts = splitUnits(text);
  if (!parts) return 0;
  const norm = parts.map((p) => p.trim().toLowerCase()).filter(Boolean);
  const n = norm.length;
  let best = 1;
  for (let i = 0; i < n; i += 1) {
    const maxL = Math.floor((n - i) / 2);
    for (let L = 1; L <= Math.min(MAX_BLOCK_UNITS, maxL); L += 1) {
      let reps = 1;
      for (;;) {
        const start = i + reps * L;
        if (start + L > n) break;
        let same = true;
        for (let k = 0; k < L; k += 1) {
          if (norm[i + k] !== norm[start + k]) {
            same = false;
            break;
          }
        }
        if (!same) break;
        reps += 1;
      }
      if (reps > best) best = reps;
    }
  }
  return best;
}
