// Pure filter evaluation. No Supabase, no AI, no I/O — just the logic
// that decides whether an email satisfies a folder's filter rules.
//
// PUBLIC API
//   applyFilter(email, filter)   — single condition test
//   matchByFilters(email, folders, filters) — choose best matching folder
//                                    or report an exclude hit
//   EXCLUDE_OPS                  — Set of ops that REMOVE a candidate
//                                    folder (not_contains, not_equals)
//   labelOf(folders, id)         — display-name lookup helper
//
// SECURITY
//   safeRegexTest enforces ReDoS bounds: patterns capped at 200 chars,
//   input capped at 10k chars, and three classic catastrophic-
//   backtracking shapes are rejected outright. Patterns failing these
//   bounds simply don't match — they don't throw.
import type { Filter, Folder, RuleNode } from "./types";

// ─── ReDoS bounds ────────────────────────────────────────────────────────

const MAX_REGEX_PATTERN_LEN = 200;
const MAX_REGEX_INPUT_LEN = 10_000;
// Nested quantifiers / overlapping alternation are the classic ReDoS shapes.
const UNSAFE_REGEX_SHAPES = [
  /(\([^)]*[+*][^)]*\))[+*]/, // (a+)+ / (a*)*
  /(\[[^\]]+\][+*]){2,}/, // [a-z]+[a-z]+ chains
  /(\.\*){2,}/, // .*.*
];

function isUnsafeRegex(pattern: string): boolean {
  if (pattern.length > MAX_REGEX_PATTERN_LEN) return true;
  return UNSAFE_REGEX_SHAPES.some((r) => r.test(pattern));
}

function safeRegexTest(pattern: string, input: string): boolean {
  if (isUnsafeRegex(pattern)) return false;
  const bounded = input.length > MAX_REGEX_INPUT_LEN ? input.slice(0, MAX_REGEX_INPUT_LEN) : input;
  try {
    return new RegExp(pattern, "i").test(bounded);
  } catch {
    return false;
  }
}

// ─── Filter evaluation ───────────────────────────────────────────────────

/** The minimal email shape applyFilter needs. The full Email row has
 * many more fields; this type keeps the function pluggable for any
 * caller that has the relevant subset. */
export type EmailForFilter = {
  from_addr: string;
  from_name: string;
  to_addrs: string;
  cc?: string;
  list_id?: string;
  in_reply_to?: string;
  subject: string;
  body_text: string;
  has_attachment: boolean;
};

export function applyFilter(email: EmailForFilter, f: Filter): boolean {
  const v = f.value.toLowerCase();
  const fieldVal = (() => {
    switch (f.field) {
      case "from":
        return `${email.from_addr} ${email.from_name}`.toLowerCase();
      case "to":
        return (email.to_addrs || "").toLowerCase();
      case "cc":
        return (email.cc || "").toLowerCase();
      case "list_id":
        return (email.list_id || "").toLowerCase();
      case "is_reply":
        return email.in_reply_to ? "true" : "false";
      case "subject":
        return (email.subject || "").toLowerCase();
      case "body":
        return (email.body_text || "").toLowerCase();
      case "domain":
        return (email.from_addr.split("@")[1] || "").toLowerCase();
      case "has_attachment":
        return email.has_attachment ? "true" : "false";
      default:
        return "";
    }
  })();
  switch (f.op) {
    case "contains":
      return fieldVal.includes(v);
    case "equals":
      return fieldVal === v;
    case "starts_with":
      return fieldVal.startsWith(v);
    case "ends_with":
      return fieldVal.endsWith(v);
    case "not_contains":
      return !fieldVal.includes(v);
    case "not_equals":
      return fieldVal !== v;
    case "regex":
      return safeRegexTest(f.value, fieldVal);
    case "domain_in": {
      // Allowlist: the (sender) domain must be one of a comma-separated set.
      // Natural predicate returns true when the domain IS in the list; the
      // exclude/veto layer inverts it to block everything outside the list.
      const domain = (email.from_addr.split("@")[1] || "").toLowerCase();
      if (!domain) return false;
      const allow = parseDomainList(f.value);
      return allow.has(domain);
    }
    default:
      return false;
  }
}

/** Split a comma/space/semicolon-separated domain allowlist into a lowercase
 * set, stripping a leading "@" and surrounding whitespace from each entry. */
export function parseDomainList(value: string): Set<string> {
  return new Set(
    value
      .split(/[\s,;]+/)
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
  );
}

// Ops that REMOVE a candidate folder instead of adding to it. `domain_in`
// vetoes when the sender domain is NOT in the allowlist; not_contains /
// not_equals veto when their positive condition holds.
export const EXCLUDE_OPS = new Set(["not_contains", "not_equals", "domain_in"]);

/** Whether an exclude-op filter vetoes this email for its folder. The veto
 * fires when: the field CONTAINS a not_contains value, EQUALS a not_equals
 * value, or the domain is OUTSIDE a domain_in allowlist. */
export function filterVetoes(email: EmailForFilter, f: Filter): boolean {
  if (f.op === "domain_in") return !applyFilter(email, f);
  if (f.op === "not_contains") return applyFilter(email, { ...f, op: "contains" });
  if (f.op === "not_equals") return applyFilter(email, { ...f, op: "equals" });
  return false;
}

/** True when any of the given folder's exclude filters veto this email.
 * Used to keep the AI classifier from assigning a folder whose allowlist /
 * exclusion the email violates, even when no include filter matched. */
export function emailVetoedForFolder(
  email: EmailForFilter,
  folderId: string,
  filters: Filter[],
): boolean {
  return filters.some(
    (f) => f.folder_id === folderId && EXCLUDE_OPS.has(f.op) && filterVetoes(email, f),
  );
}

function evalNode(email: EmailForFilter, node: RuleNode): boolean {
  if (node.type === "cond") {
    return applyFilter(email, {
      id: "",
      folder_id: "",
      field: node.field,
      op: node.op,
      value: node.value,
    });
  }
  if (node.op === "and") return node.children.every((c) => evalNode(email, c));
  return node.children.some((c) => evalNode(email, c));
}

function countConds(node: RuleNode): number {
  return node.type === "cond" ? 1 : node.children.reduce((n, c) => n + countConds(c), 0);
}

/** Walk a rule tree and return field/op/value for every leaf
 * (`type: "cond"`) that evaluates true against `email`. The UI uses
 * this to pinpoint which leaf(s) in a folder's filter_tree matched,
 * since tree leaves don't have folder_filters row IDs. */
export function collectMatchingLeaves(
  email: EmailForFilter,
  node: RuleNode,
): Array<{ field: string; op: string; value: string }> {
  if (node.type === "cond") {
    return applyFilter(email, {
      id: "",
      folder_id: "",
      field: node.field,
      op: node.op,
      value: node.value,
    })
      ? [{ field: node.field, op: node.op, value: node.value }]
      : [];
  }
  return node.children.flatMap((c) => collectMatchingLeaves(email, c));
}

// ─── Folder matching ────────────────────────────────────────────────────

export type FolderMatch =
  | {
      kind: "match";
      folder_id: string;
      filter: Filter | null;
      matched_filters: Filter[];
      all_matched_folder_ids: string[];
      tree_used: boolean;
    }
  | { kind: "excluded"; folder_id: string; folder_name: string; exclude: Filter };

/** Walks the configured folders + filters and returns the best match
 * for `email`, an `excluded` reason if any folder excluded it via a
 * not_contains/not_equals rule, or null if nothing matched. */
export function matchByFilters(
  email: EmailForFilter,
  folders: Folder[],
  filters: Filter[],
): FolderMatch | null {
  const byFolder = new Map<string, Filter[]>();
  for (const f of filters) {
    if (!byFolder.has(f.folder_id)) byFolder.set(f.folder_id, []);
    byFolder.get(f.folder_id)!.push(f);
  }
  const matched: Array<{
    folder: Folder;
    filter: Filter | null;
    allMatches: Filter[];
    treeUsed: boolean;
  }> = [];
  const excludedFolders: Array<{ folder: Folder; exclude: Filter }> = [];
  for (const folder of folders) {
    const fs = byFolder.get(folder.id) || [];
    const excludes = fs.filter((f) => EXCLUDE_OPS.has(f.op));
    const includes = fs.filter((f) => !EXCLUDE_OPS.has(f.op));

    // Tree takes precedence when present and non-empty.
    const tree = folder.filter_tree;
    const hasTree =
      !!tree && (tree.type === "cond" || (tree.type === "group" && countConds(tree) > 0));

    let passes: boolean;
    let includeHits: Filter[] = [];
    if (hasTree) {
      passes = evalNode(email, tree!);
    } else {
      if (includes.length === 0) continue;
      includeHits = includes.filter((f) => applyFilter(email, f));
      const logic = folder.filter_logic === "all" ? "all" : "any";
      passes = logic === "all" ? includeHits.length === includes.length : includeHits.length > 0;
    }
    if (!passes) continue;

    // An exclude filter VETOes the folder when its *positive* condition holds:
    //   not_contains X → veto if the field contains X
    //   not_equals   X → veto if the field equals X
    // (applyFilter returns the literal predicate, so checking it directly would
    // invert the veto — fire when the value is absent.)
    const excludeHit = excludes.find((f) =>
      applyFilter(email, { ...f, op: f.op === "not_contains" ? "contains" : "equals" }),
    );
    if (excludeHit) {
      excludedFolders.push({ folder, exclude: excludeHit });
      continue;
    }
    matched.push({
      folder,
      filter: hasTree ? null : (includeHits[0] ?? null),
      allMatches: hasTree ? [] : includeHits,
      treeUsed: hasTree,
    });
  }
  if (matched.length > 0) {
    // Sort: highest priority first, then folder name asc for stable tiebreak.
    matched.sort(
      (a, b) => b.folder.priority - a.folder.priority || a.folder.name.localeCompare(b.folder.name),
    );
    return {
      kind: "match",
      folder_id: matched[0].folder.id,
      filter: matched[0].filter,
      matched_filters: matched[0].allMatches,
      all_matched_folder_ids: matched.map((m) => m.folder.id),
      tree_used: matched[0].treeUsed,
    };
  }
  if (excludedFolders.length > 0) {
    excludedFolders.sort(
      (a, b) => b.folder.priority - a.folder.priority || a.folder.name.localeCompare(b.folder.name),
    );
    return {
      kind: "excluded",
      folder_id: excludedFolders[0].folder.id,
      folder_name: excludedFolders[0].folder.name,
      exclude: excludedFolders[0].exclude,
    };
  }
  return null;
}

export function labelOf(folders: Folder[], id: string): string {
  return folders.find((f) => f.id === id)?.name ?? "folder";
}
