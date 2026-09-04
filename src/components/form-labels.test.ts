// Every form control in the app must carry an accessible name.
//
// Two static sweeps, one per way this codebase gets it wrong.
//
// ── Select triggers ──────────────────────────────────────────────────
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

// ── Captions that associate with nothing ─────────────────────────────
//
// The other half of the same mistake, on plain inputs: a shadcn `<Label>`
// sitting above an `<Input>` / `<Textarea>` with no `htmlFor`. It looks
// labelled and reads as an unlabelled edit box — clicking the caption
// focuses nothing, and a screen reader announces only the placeholder, if
// there even is one.
//
// The fix is either `htmlFor` + `id`, or the `Field` wrapper
// (components/contacts/Field.tsx), which nests the control INSIDE its
// label so the association holds whatever the control renders. Nesting is
// why this sweep cannot simply flag every unlabelled `<Input>`: most of
// them are correctly wrapped, and only a *sibling* caption is a defect.

/** Each `<Label …>text</Label>` immediately followed by an Input/Textarea,
 * with nothing between them that would nest the control. */
function orphanCaptions(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const re =
    /<Label\b([^>]*)>([\s\S]{0,160}?)<\/Label>\s*\n([\s\S]{0,320}?)<(?:Input|Textarea)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const [, labelAttrs = "", caption = "", between = "", controlAttrs = ""] = m;
    if (/htmlFor=/.test(labelAttrs)) continue;
    if (/\bid=|\baria-label(ledby)?=/.test(controlAttrs)) continue;
    // A Field or a raw <label> between the two nests the control instead.
    if (between.includes("<Field") || between.includes("<label")) continue;
    out.push({
      line: source.slice(0, m.index).split("\n").length,
      text: caption.replace(/\s+/g, " ").trim().slice(0, 40),
    });
  }
  return out;
}

describe("captions are associated with their control", () => {
  it("no Label sits beside an Input or Textarea it does not name", () => {
    const orphans: string[] = [];
    for (const rel of FILES) {
      const source = readFileSync(path.join(SRC, rel), "utf8");
      for (const { line, text } of orphanCaptions(source)) {
        orphans.push(`${rel}:${line}  "${text}"`);
      }
    }
    expect(
      orphans,
      "these captions associate with nothing — add htmlFor + id, or wrap the " +
        "control in <Field label=…> so the label nests it:\n" +
        orphans.join("\n"),
    ).toEqual([]);
  });

  it("accepts htmlFor, an id on the control, and Field nesting", () => {
    const withHtmlFor = `<Label htmlFor="a">A</Label>\n<Input />\n`;
    const withId = `<Label>A</Label>\n<Input id="a" />\n`;
    const nested = `<Label>A</Label>\n<Field label="A">\n<Input />\n`;
    for (const source of [withHtmlFor, withId, nested]) {
      expect(orphanCaptions(source)).toEqual([]);
    }
  });

  it("still catches a bare sibling caption", () => {
    expect(orphanCaptions(`<Label>Notes</Label>\n<Textarea rows={4} />\n`)).toHaveLength(1);
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
