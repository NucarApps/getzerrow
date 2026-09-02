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
import { emailDomain } from "../company-domains";

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
  /** Reply-To address, when the message carried one. */
  reply_to_addr?: string | null;
  /** True sender when the message reached us through an auto-forward
   * (see gmail/origin-sender.ts). Absent/null for direct mail, in which
   * case the `origin_*` fields fall back to from_addr. */
  origin_addr?: string | null;
  subject: string;
  body_text: string;
  has_attachment: boolean;
  /** IDs of contact_groups the sender belongs to for this user. Populated
   * at classify time from AccountContext. Empty/absent for messages
   * whose sender isn't a saved contact. */
  sender_group_ids?: string[];
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
        return emailDomain(email.from_addr) ?? "";
      case "origin_from": {
        // The real sender: the origin address for forwarded mail, else From.
        // Falling back keeps one rule working for both direct and relayed mail.
        const addr = email.origin_addr || email.from_addr || "";
        return addr.toLowerCase();
      }
      case "origin_domain":
        return emailDomain(email.origin_addr || email.from_addr) ?? "";
      case "reply_to":
        return (email.reply_to_addr || "").toLowerCase();
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
      const domain = emailDomain(email.from_addr);
      if (!domain) return false;
      const allow = parseDomainList(f.value);
      return allow.has(domain);
    }
    case "sender_in_group": {
      // Include op: the sender must be a member of the contact group whose
      // id is stored in f.value. Resolved into email.sender_group_ids by
      // the classifier before evaluation.
      return email.sender_group_ids?.includes(f.value) ?? false;
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

/**
 * Evaluate one rule leaf against a partially-known email — the shape the UI
 * has when it explains why a message was filed.
 *
 * The UI used to carry its own copies of this switch (two of them), which
 * drifted: neither implemented starts_with / ends_with / domain_in, so mail
 * filed by those rules showed "couldn't pinpoint" instead of its rule. Any
 * field the caller does not know reads as empty, exactly as it does here.
 */
export function matchesLeaf(
  email: { [K in keyof EmailForFilter]?: EmailForFilter[K] | null },
  leaf: { field: string; op: string; value: string },
): boolean {
  const full: EmailForFilter = {
    ...(email as Partial<EmailForFilter>),
    from_addr: email.from_addr ?? "",
    from_name: email.from_name ?? "",
    to_addrs: email.to_addrs ?? "",
    subject: email.subject ?? "",
    body_text: email.body_text ?? "",
    has_attachment: email.has_attachment ?? false,
  };
  return applyFilter(full, { id: "", folder_id: "", ...leaf });
}

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

// ─── Tree bounds ─────────────────────────────────────────────────────────
// ReDoS bounds cap each condition; these cap the tree itself. A
// filter_tree with thousands of leaves (or absurd nesting) is a DoS on
// the classify hot path, so oversized/malformed trees are rejected at
// save time (FolderEditor) and evaluate to "no match" at classify time.

export const MAX_FILTER_TREE_DEPTH = 8;
export const MAX_FILTER_TREE_LEAVES = 128;

export type RuleNodeValidation = { ok: true } | { ok: false; reason: string };

/** Structural + size validation for a folder's filter_tree. Checks node
 * shape (unknown types, non-string cond fields, non-array children),
 * nesting depth ≤ MAX_FILTER_TREE_DEPTH, and total leaf count ≤
 * MAX_FILTER_TREE_LEAVES. O(n) with early exit — safe to call on
 * untrusted trees. */
export function validateRuleNode(node: RuleNode): RuleNodeValidation {
  let leaves = 0;
  function walk(n: RuleNode, depth: number): string | null {
    if (depth > MAX_FILTER_TREE_DEPTH) {
      return `rule groups nested deeper than ${MAX_FILTER_TREE_DEPTH} levels`;
    }
    if (!n || typeof n !== "object") return "malformed rule node (not an object)";
    if (n.type === "cond") {
      if (typeof n.field !== "string" || typeof n.op !== "string" || typeof n.value !== "string") {
        return "malformed condition (field/op/value must be strings)";
      }
      leaves++;
      if (leaves > MAX_FILTER_TREE_LEAVES) {
        return `more than ${MAX_FILTER_TREE_LEAVES} conditions in one rule tree`;
      }
      return null;
    }
    if (n.type === "group") {
      if (n.op !== "and" && n.op !== "or") return 'malformed group (op must be "and" or "or")';
      if (!Array.isArray(n.children)) return "malformed group (children must be an array)";
      for (const c of n.children) {
        const err = walk(c, depth + 1);
        if (err) return err;
      }
      return null;
    }
    return `malformed rule node (unknown type "${String((n as { type?: unknown }).type)}")`;
  }
  const err = walk(node, 1);
  return err ? { ok: false, reason: err } : { ok: true };
}

function evalNodeUnchecked(email: EmailForFilter, node: RuleNode): boolean {
  if (node.type === "cond") {
    return applyFilter(email, {
      id: "",
      folder_id: "",
      field: node.field,
      op: node.op,
      value: node.value,
    });
  }
  if (node.op === "and") return node.children.every((c) => evalNodeUnchecked(email, c));
  return node.children.some((c) => evalNodeUnchecked(email, c));
}

/** Evaluate a rule tree against an email. Trees exceeding the bounds (or
 * structurally malformed) never match — the folder's tree is inert until
 * fixed, rather than a classify-time DoS. */
function evalNode(email: EmailForFilter, node: RuleNode): boolean {
  if (!validateRuleNode(node).ok) return false;
  return evalNodeUnchecked(email, node);
}

function countConds(node: RuleNode): number {
  return node.type === "cond" ? 1 : node.children.reduce((n, c) => n + countConds(c), 0);
}

/** Walk a rule tree and return field/op/value for every leaf
 * (`type: "cond"`) that evaluates true against `email`. The UI uses
 * this to pinpoint which leaf(s) in a folder's filter_tree matched,
 * since tree leaves don't have folder_filters row IDs. Out-of-bounds /
 * malformed trees short-circuit to no leaves, mirroring evalNode. */
export function collectMatchingLeaves(
  email: EmailForFilter,
  node: RuleNode,
): Array<{ field: string; op: string; value: string }> {
  if (!validateRuleNode(node).ok) return [];
  return collectLeavesUnchecked(email, node);
}

function collectLeavesUnchecked(
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
  return node.children.flatMap((c) => collectLeavesUnchecked(email, c));
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
      /** True when the winning folder is thread-scoped and only a PRIOR
       * message in the thread satisfied its rules (the incoming message
       * alone would not have matched). */
      matched_via_thread: boolean;
    }
  | { kind: "excluded"; folder_id: string; folder_name: string; exclude: Filter };

/** Why one folder did or didn't take an email, for the decision trace.
 * Config-only (folder names + rule field/op/value) — never email content,
 * so a trace is safe to store unencrypted and render in the UI. */
export type CandidateVerdict =
  "matched" | "vetoed" | "paused" | "no_rules" | "invalid_tree" | "no_match";

export type CandidateTrace = {
  folder_id: string;
  folder_name: string;
  priority: number;
  verdict: CandidateVerdict;
  /** Leaf/filter conditions that fired for this folder (matched only). */
  matched: Array<{ field: string; op: string; value: string }>;
  /** The exclude rule that disqualified the folder (vetoed only). */
  veto?: { field: string; op: string; value: string };
  /** True when only a prior message in the thread satisfied the rules. */
  via_thread?: boolean;
};

export type ExplainedMatch = { match: FolderMatch | null; candidates: CandidateTrace[] };

/** Walks the configured folders + filters and returns the best match
 * for `email`, an `excluded` reason if any folder excluded it via a
 * not_contains/not_equals rule, or null if nothing matched. */
export function matchByFilters(
  email: EmailForFilter,
  folders: Folder[],
  filters: Filter[],
): FolderMatch | null {
  return matchByFiltersOnThread(email, [], folders, filters);
}

/** Thread-aware variant of matchByFilters. For folders with
 * run_on_threads=true the include rules are evaluated per message across
 * [email, ...threadEmails] — the folder matches when ANY message
 * satisfies them (task 6). All other folders keep exact message-scope
 * behavior, and priority/tiebreak sorting is shared across both kinds so
 * a thread match never jumps the priority order.
 *
 * Exclude/veto rules always evaluate against the INCOMING message only:
 * routing decisions veto on the mail actually being routed, not on
 * historical thread content. */
export function matchByFiltersOnThread(
  email: EmailForFilter,
  threadEmails: EmailForFilter[],
  folders: Folder[],
  filters: Filter[],
): FolderMatch | null {
  return matchByFiltersExplained(email, threadEmails, folders, filters).match;
}

/** matchByFiltersOnThread plus a per-folder verdict list. The decision
 * trace needs to explain the folders that LOST — vetoed, paused, ruleless,
 * or beaten on priority — and those are computed here anyway; the plain
 * wrapper above throws them away for hot-path callers that don't care. */
export function matchByFiltersExplained(
  email: EmailForFilter,
  threadEmails: EmailForFilter[],
  folders: Folder[],
  filters: Filter[],
): ExplainedMatch {
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
    viaThread: boolean;
    leaves: Array<{ field: string; op: string; value: string }>;
  }> = [];
  const excludedFolders: Array<{ folder: Folder; exclude: Filter }> = [];
  const candidates: CandidateTrace[] = [];
  const note = (folder: Folder, verdict: CandidateVerdict, extra?: Partial<CandidateTrace>) => {
    candidates.push({
      folder_id: folder.id,
      folder_name: folder.name,
      priority: folder.priority,
      verdict,
      matched: [],
      ...extra,
    });
  };

  for (const folder of folders) {
    // Paused folder — user disabled filtering & rules. Skip entirely so no
    // rule matches, no side-effects, no candidacy for downstream AI.
    if (folder.processing_enabled === false) {
      note(folder, "paused");
      continue;
    }
    const fs = byFolder.get(folder.id) || [];
    const excludes = fs.filter((f) => EXCLUDE_OPS.has(f.op));
    const includes = fs.filter((f) => !EXCLUDE_OPS.has(f.op));
    const candidateMsgs =
      folder.run_on_threads === true && threadEmails.length > 0
        ? [email, ...threadEmails]
        : [email];

    // Tree takes precedence when present and non-empty. Validate BEFORE
    // countConds — the validator's depth check stops descending at the
    // cap, so a maliciously deep tree can't blow the stack here. An
    // out-of-bounds/malformed tree makes the folder inert (no fallback to
    // the flat filters, which the tree superseded and may be stale).
    const tree = folder.filter_tree;
    if (tree && !validateRuleNode(tree).ok) {
      note(folder, "invalid_tree");
      continue;
    }
    const hasTree =
      !!tree && (tree.type === "cond" || (tree.type === "group" && countConds(tree) > 0));

    // Find the first message (incoming first) that satisfies the folder's
    // include rules — each message is evaluated against the FULL rule
    // (per-message all/any or tree), never mixing fields across messages.
    let matchIndex = -1;
    let includeHits: Filter[] = [];
    if (hasTree) {
      matchIndex = candidateMsgs.findIndex((c) => evalNode(c, tree!));
    } else {
      if (includes.length === 0) {
        note(folder, "no_rules");
        continue;
      }
      const logic = folder.filter_logic === "all" ? "all" : "any";
      for (let i = 0; i < candidateMsgs.length; i++) {
        const hits = includes.filter((f) => applyFilter(candidateMsgs[i]!, f));
        const passes = logic === "all" ? hits.length === includes.length : hits.length > 0;
        if (passes) {
          matchIndex = i;
          includeHits = hits;
          break;
        }
      }
    }
    if (matchIndex < 0) {
      note(folder, "no_match");
      continue;
    }

    // An exclude filter VETOes the folder when its positive condition holds:
    //   not_contains X → veto if the field contains X
    //   not_equals   X → veto if the field equals X
    //   domain_in  list → veto if the sender domain is NOT in the allowlist
    const excludeHit = excludes.find((f) => filterVetoes(email, f));
    if (excludeHit) {
      excludedFolders.push({ folder, exclude: excludeHit });
      note(folder, "vetoed", {
        veto: { field: excludeHit.field, op: excludeHit.op, value: excludeHit.value },
      });
      continue;
    }
    const leaves = hasTree
      ? collectMatchingLeaves(candidateMsgs[matchIndex]!, tree!)
      : includeHits.map((f) => ({ field: f.field, op: f.op, value: f.value }));
    matched.push({
      folder,
      filter: hasTree ? null : (includeHits[0] ?? null),
      allMatches: hasTree ? [] : includeHits,
      treeUsed: hasTree,
      viaThread: matchIndex > 0,
      leaves,
    });
    note(folder, "matched", { matched: leaves, via_thread: matchIndex > 0 });
  }
  if (matched.length > 0) {
    // Sort: highest priority first, then folder name asc for stable tiebreak.
    matched.sort(
      (a, b) => b.folder.priority - a.folder.priority || a.folder.name.localeCompare(b.folder.name),
    );
    const top = matched[0]!;
    return {
      match: {
        kind: "match",
        folder_id: top.folder.id,
        filter: top.filter,
        matched_filters: top.allMatches,
        all_matched_folder_ids: matched.map((m) => m.folder.id),
        tree_used: top.treeUsed,
        matched_via_thread: top.viaThread,
      },
      candidates,
    };
  }
  if (excludedFolders.length > 0) {
    excludedFolders.sort(
      (a, b) => b.folder.priority - a.folder.priority || a.folder.name.localeCompare(b.folder.name),
    );
    const top = excludedFolders[0]!;
    return {
      match: {
        kind: "excluded",
        folder_id: top.folder.id,
        folder_name: top.folder.name,
        exclude: top.exclude,
      },
      candidates,
    };
  }
  return { match: null, candidates };
}

export function labelOf(folders: Folder[], id: string): string {
  return folders.find((f) => f.id === id)?.name ?? "folder";
}
