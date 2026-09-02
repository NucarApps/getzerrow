// Keeps the known-bug register and the tests that pin it in step.
//
// The September 2026 review found seven bugs described in a hand-kept note
// as "pinned by a characterization test" that no test pinned at all. The
// note and the suite had drifted, and nothing could tell. This test makes
// drift impossible in both directions: a marker without a register entry
// fails, and a register entry nothing pins fails.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTERIZATIONS } from "./__fixtures__/characterizations";

const MARKER = /\/\/\s*CHARACTERIZATION\(([^)]*)\)/g;

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      testFiles(full, out);
      continue;
    }
    if (/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** slug → the files pinning it. */
function markersInTests(): Map<string, string[]> {
  const root = process.cwd();
  const found = new Map<string, string[]>();
  for (const dir of ["src", "tests"]) {
    for (const file of testFiles(join(root, dir))) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(MARKER)) {
        const slug = m[1]!.trim();
        const rel = file.slice(root.length + 1);
        found.set(slug, [...(found.get(slug) ?? []), rel]);
      }
    }
  }
  return found;
}

describe("characterization register", () => {
  const found = markersInTests();

  it("finds the markers (guard against a regex that silently matches nothing)", () => {
    expect(found.size).toBeGreaterThan(0);
  });

  it("every CHARACTERIZATION marker names a slug that is in the register", () => {
    const unknown = [...found.keys()].filter((slug) => !(slug in CHARACTERIZATIONS));
    expect(
      unknown,
      "markers whose slug is missing from src/lib/__fixtures__/characterizations.ts — " +
        "add an entry saying what is wrong and where the fix belongs",
    ).toEqual([]);
  });

  it("every registered characterization is still pinned by a test", () => {
    const unpinned = Object.keys(CHARACTERIZATIONS).filter((slug) => !found.has(slug));
    expect(
      unpinned,
      "registered bugs that no test pins any more — if the bug is fixed, delete its " +
        "entry; if the pin was lost, restore it. A register entry with no test behind " +
        "it is exactly the drift this check exists to prevent",
    ).toEqual([]);
  });

  it("slugs are kebab-case and descriptive", () => {
    for (const slug of Object.keys(CHARACTERIZATIONS)) {
      expect(slug, `${slug} should be kebab-case`).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/);
      expect(slug.length, `${slug} is too terse to identify a bug`).toBeGreaterThan(8);
    }
  });

  it("each register entry says what is wrong and where the fix belongs", () => {
    for (const [slug, entry] of Object.entries(CHARACTERIZATIONS)) {
      expect(
        entry.what.length,
        `${slug}: 'what' should describe the wrong behaviour`,
      ).toBeGreaterThan(30);
      expect(entry.fixIn, `${slug}: 'fixIn' should name the source file to change`).toMatch(
        /^(src|supabase)\//,
      );
    }
  });
});
