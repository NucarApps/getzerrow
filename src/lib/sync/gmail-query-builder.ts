// Translate a folder's rule definition (flat folder_filters OR a filter_tree)
// into Gmail search query strings, respecting AND/OR grouping semantics.
//
// Gmail's search language treats space-separated terms as AND and explicit
// `{ a b }` / `OR` as OR. To keep things readable and avoid quoting bugs we
// expand OR branches into separate queries and keep AND branches as a single
// space-separated query.
//
// Pure module (no Supabase / no I/O) so it can be unit tested.
import type { RuleNode } from "./types";

export type Cond = { field: string; op: string; value: string };

const SUPPORTED_FIELDS = new Set([
  "from", "to", "cc", "subject", "body", "domain", "list_id", "has_attachment",
]);

function isUsableCond(c: Cond): boolean {
  // negative ops and regex can't be expressed in Gmail search.
  if (c.op === "not_contains" || c.op === "not_equals" || c.op === "regex") return false;
  if (!SUPPORTED_FIELDS.has(c.field)) return false;
  if (!c.value || !c.value.trim()) return false;
  return true;
}

function quote(v: string): string {
  const trimmed = v.trim();
  if (!trimmed) return "";
  return /[\s:]/.test(trimmed) ? `"${trimmed.replace(/"/g, '\\"')}"` : trimmed;
}

function condToTerm(c: Cond): string | null {
  const v = c.value.trim();
  if (!v) return null;
  switch (c.field) {
    case "domain": return `from:${v.replace(/^@/, "")}`;
    case "from": return `from:${quote(v)}`;
    case "to": return `to:${quote(v)}`;
    case "cc": return `cc:${quote(v)}`;
    case "subject": return `subject:${quote(v)}`;
    case "body": return quote(v);
    case "list_id": return `list:${quote(v)}`;
    case "has_attachment": return v === "true" ? "has:attachment" : null;
    default: return null;
  }
}

/** Expand a rule tree into a list of AND-branch term-arrays. Each entry is
 * one Gmail query — its terms joined with spaces. OR groups fan out into
 * multiple entries; AND groups concatenate child term-arrays. Negative /
 * regex / unsupported leaves are dropped. */
export function expandTreeToBranches(node: RuleNode): string[][] {
  if (node.type === "cond") {
    if (!isUsableCond(node)) return [];
    const term = condToTerm(node);
    return term ? [[term]] : [];
  }
  const childBranches = node.children.map(expandTreeToBranches);
  if (node.op === "or") {
    // Union — every child branch is its own query.
    return childBranches.flat();
  }
  // AND — Cartesian product of child branches.
  let acc: string[][] = [[]];
  for (const branches of childBranches) {
    if (branches.length === 0) continue; // ignore children that contributed nothing
    const next: string[][] = [];
    for (const a of acc) {
      for (const b of branches) {
        next.push([...a, ...b]);
      }
    }
    acc = next;
  }
  // If no child produced anything, acc stays at [[]] — return [] so caller
  // doesn't issue an empty query.
  if (acc.length === 1 && acc[0].length === 0) return [];
  return acc;
}

export type BuildOptions = {
  /** Suffix appended to each query (e.g. " newer_than:6m"). */
  suffix?: string;
  /** Maximum queries to return (Gmail rate-limit guard). */
  maxQueries?: number;
};

/** Build a deduplicated set of Gmail query strings from a rule tree
 * and/or flat filter rows. When a non-empty `filter_tree` is present
 * it is authoritative — flat filters are ignored (mirrors the runtime
 * filter engine's precedence rule). */
export function buildGmailQueries(
  input: { filter_tree: RuleNode | null; filters: Cond[] },
  options: BuildOptions = {},
): { queries: string[]; skippedRegex: number } {
  const suffix = options.suffix ?? "";
  const max = options.maxQueries ?? 20;
  const out = new Set<string>();
  let skippedRegex = 0;

  const tree = input.filter_tree;
  const hasTree = !!tree && (tree.type === "cond" || (tree.type === "group" && tree.children.length > 0));

  if (hasTree) {
    // Count skipped regex leaves for reporting parity with the old impl.
    const countRegex = (n: RuleNode): number => {
      if (n.type === "cond") return n.op === "regex" ? 1 : 0;
      return n.children.reduce((s, c) => s + countRegex(c), 0);
    };
    skippedRegex = countRegex(tree!);
    for (const branch of expandTreeToBranches(tree!)) {
      if (branch.length === 0) continue;
      const q = branch.join(" ") + suffix;
      out.add(q);
      if (out.size >= max) break;
    }
  } else {
    for (const f of input.filters) {
      if (f.op === "regex") { skippedRegex++; continue; }
      if (!isUsableCond(f)) continue;
      const term = condToTerm(f);
      if (!term) continue;
      out.add(term + suffix);
      if (out.size >= max) break;
    }
  }

  return { queries: Array.from(out), skippedRegex };
}
