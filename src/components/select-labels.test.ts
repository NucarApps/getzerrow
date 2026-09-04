// Every Radix Select trigger in the app must carry an accessible name.
//
// This one keeps coming back. A `<Select>` is captioned by a `<Label>` or
// a `<span>` sitting above it, which LOOKS labelled — but a Radix trigger
// is a `<button>` that takes no `htmlFor`, so nothing connects the two.
// A screen reader then announces the control as a bare combobox with only
// its current value ("Newsletters", "contains", "Every 5 min"), giving no
// idea what is being chosen. It was found and fixed one component at a
// time in GroupEditorDialog, InboxOverrides and AddFolderDialog before
// this sweep went in and turned up eighteen more.
//
// Self-maintaining: the files are enumerated from the tree, so a Select
// added tomorrow is swept the moment it lands. `aria-label` or
// `aria-labelledby` both satisfy it — use whichever fits, but a visible
// caption pointed at by `aria-labelledby` is better, since it keeps the
// announced name and the seen name the same string.
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The vendored shadcn primitive that DEFINES SelectTrigger; it takes the
 * name from its caller and cannot supply one itself. */
const PRIMITIVE = "components/ui/select.tsx";

function tsxFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .map((p) => p.split(path.sep).join("/"))
    .filter((rel) => rel.endsWith(".tsx") && !rel.endsWith(".test.tsx"))
    .filter((rel) => rel !== PRIMITIVE)
    .sort();
}

/** Each `<SelectTrigger …>` opening tag, with the line it starts on. */
function triggers(source: string): Array<{ line: number; tag: string }> {
  const out: Array<{ line: number; tag: string }> = [];
  const re = /<SelectTrigger\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    // Read to the end of the opening tag, so a name on a later line counts.
    const end = source.indexOf(">", m.index);
    out.push({
      line: source.slice(0, m.index).split("\n").length,
      tag: source.slice(m.index, end < 0 ? source.length : end + 1),
    });
  }
  return out;
}

const hasName = (tag: string) => /\baria-label(ledby)?\s*=/.test(tag);

const FILES = tsxFiles();

describe("Select triggers are named", () => {
  it("found the component tree to sweep", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES).toContain("components/settings/InboxOverrides.tsx");
  });

  it("sweeps a meaningful number of Select triggers", () => {
    // Guards the sweep itself: a regex that stopped matching would leave
    // every one of these unchecked while still passing.
    const total = FILES.reduce(
      (n, rel) => n + triggers(readFileSync(path.join(SRC, rel), "utf8")).length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(20);
  });

  it("every SelectTrigger has an aria-label or aria-labelledby", () => {
    const unnamed: string[] = [];
    for (const rel of FILES) {
      const source = readFileSync(path.join(SRC, rel), "utf8");
      for (const { line, tag } of triggers(source)) {
        if (!hasName(tag)) unnamed.push(`${rel}:${line}`);
      }
    }
    expect(
      unnamed,
      "these Select triggers announce only their current value — add aria-label, " +
        "or aria-labelledby pointing at the visible caption:\n" +
        unnamed.join("\n"),
    ).toEqual([]);
  });
});

describe("the sweep's own reading of a tag", () => {
  it("accepts a name on a later line of a multi-line tag", () => {
    const source = `<SelectTrigger\n  className="x"\n  aria-label="Pick one"\n>\n`;
    expect(triggers(source).every((t) => hasName(t.tag))).toBe(true);
  });

  it("does not accept a name that belongs to a later element", () => {
    const source = `<SelectTrigger className="x">\n  <span aria-label="not mine" />\n`;
    expect(triggers(source).every((t) => hasName(t.tag))).toBe(false);
  });

  it("counts every trigger in a file, not just the first", () => {
    const source = `<SelectTrigger a />\n<SelectTrigger b />\n`;
    expect(triggers(source)).toHaveLength(2);
  });
});
