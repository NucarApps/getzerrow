// Save-time collision checking (Amendment 3, Phase D).
//
// A rule is never saved into a silent conflict. Before a rule is written,
// it is evaluated against a sample of recent messages alongside every
// existing rule, and each overlap is classified by the ladder:
//
//   same level, same folder       -> merge      (redundant: fold it in)
//   same level, different folder  -> block      (ambiguous: must be fixed)
//   different level, any folder   -> info       (the ladder already decides)
//
// Overlap is measured empirically — the two rules both matched the same
// real message — rather than inferred from condition text, so it agrees
// with what the engine will actually do at filing time.
//
// PURE: no Supabase, no clock. The caller supplies the message sample.
import { evaluateRule } from "./resolve";
import { levelLabel, ruleConditionCount, ruleLevel } from "./specificity";
import type { EngineFolder, EngineMessage, Rule, SpecificityLevel } from "./types";

export type ConflictKind = "merge" | "block" | "info";

/** One overlapping message, trimmed to what a fix card shows. */
export type ConflictSample = {
  id: string;
  subject: string | null;
  from_addr: string | null;
  received_at: string | null;
};

export type RuleConflict = {
  kind: ConflictKind;
  /** The existing rule the candidate overlaps with. */
  rule_id: string;
  folder_id: string;
  folder_name: string;
  level: SpecificityLevel;
  candidate_level: SpecificityLevel;
  /** How many sampled messages both rules claimed. */
  overlap_count: number;
  samples: ConflictSample[];
  /** Which rule the ladder would pick for the overlap, for "info". */
  winner: "candidate" | "existing" | "tie";
  message: string;
};

export type ConflictReport = {
  /** True when at least one conflict is kind "block". */
  blocked: boolean;
  conflicts: RuleConflict[];
  /** Sampled messages the candidate rule matched, whether or not they
   * collided — the "this rule matches N messages" count in the editor. */
  candidate_match_count: number;
  candidate_samples: ConflictSample[];
  candidate_level: SpecificityLevel;
};

export const MAX_CONFLICT_SAMPLES = 5;

/** A message plus the identity a fix card needs to show it. */
export type SampleMessage = EngineMessage & {
  id: string;
  received_at?: string | null;
};

const toSample = (m: SampleMessage): ConflictSample => ({
  id: m.id,
  subject: m.subject ?? null,
  from_addr: m.from_addr ?? null,
  received_at: m.received_at ?? null,
});

function ladderWinner(candidate: Rule, existing: Rule): RuleConflict["winner"] {
  const byLevel = ruleLevel(candidate) - ruleLevel(existing);
  if (byLevel !== 0) return byLevel < 0 ? "candidate" : "existing";
  const byConditions = ruleConditionCount(existing) - ruleConditionCount(candidate);
  if (byConditions !== 0) return byConditions < 0 ? "candidate" : "existing";
  return "tie";
}

function describe(
  kind: ConflictKind,
  candidate: Rule,
  existing: Rule,
  folderName: string,
  overlap: number,
  winner: RuleConflict["winner"],
): string {
  const level = levelLabel(ruleLevel(existing));
  const msgs = `${overlap} recent message${overlap === 1 ? "" : "s"}`;
  if (kind === "merge") {
    return `An existing ${level} rule already files ${msgs} into "${folderName}" — fold this into that rule instead of adding a second one.`;
  }
  if (kind === "block") {
    return `An existing ${level} rule claims ${msgs} for "${folderName}". Two rules at the same level cannot claim the same mail for different folders — narrow one of them or add an exception.`;
  }
  const decider =
    winner === "candidate"
      ? `this rule (${levelLabel(ruleLevel(candidate))}) wins`
      : winner === "existing"
        ? `the existing ${level} rule wins`
        : "the older rule wins";
  return `Overlaps an existing rule for "${folderName}" on ${msgs}. The ladder already decides this: ${decider}.`;
}

/** Check a candidate rule against the current rule set.
 *
 * `existing` should exclude the candidate itself when editing — pass the
 * rule id in `opts.ignoreRuleIds` and the check drops it for you, so an
 * edit never conflicts with the version it replaces. */
export function checkRuleConflicts(
  candidate: Rule,
  existing: Rule[],
  folders: EngineFolder[],
  messages: SampleMessage[],
  opts: { ignoreRuleIds?: string[] } = {},
): ConflictReport {
  const ignored = new Set([candidate.id, ...(opts.ignoreRuleIds ?? [])]);
  const candidateLevel = ruleLevel(candidate);
  const nameOf = (id: string) => folders.find((f) => f.id === id)?.name ?? "folder";
  const paused = (id: string) => folders.find((f) => f.id === id)?.processing_enabled === false;

  const candidateHits: SampleMessage[] = [];
  const overlaps = new Map<string, SampleMessage[]>();

  const others = existing.filter(
    (r) => !ignored.has(r.id) && r.enabled !== false && !paused(r.folder_id),
  );

  for (const m of messages) {
    if (!evaluateRule(candidate, m).matched) continue;
    candidateHits.push(m);
    for (const other of others) {
      if (!evaluateRule(other, m).matched) continue;
      const bucket = overlaps.get(other.id);
      if (bucket) bucket.push(m);
      else overlaps.set(other.id, [m]);
    }
  }

  const byId = new Map(others.map((r) => [r.id, r]));
  const conflicts: RuleConflict[] = [];

  for (const [ruleId, hits] of overlaps) {
    const other = byId.get(ruleId)!;
    const otherLevel = ruleLevel(other);
    const sameLevel = otherLevel === candidateLevel;
    const sameFolder = other.folder_id === candidate.folder_id;
    const kind: ConflictKind = sameLevel ? (sameFolder ? "merge" : "block") : "info";
    const winner = ladderWinner(candidate, other);
    const folderName = nameOf(other.folder_id);
    conflicts.push({
      kind,
      rule_id: other.id,
      folder_id: other.folder_id,
      folder_name: folderName,
      level: otherLevel,
      candidate_level: candidateLevel,
      overlap_count: hits.length,
      samples: hits.slice(0, MAX_CONFLICT_SAMPLES).map(toSample),
      winner,
      message: describe(kind, candidate, other, folderName, hits.length, winner),
    });
  }

  // Blocking conflicts first, then merges, then informational — the editor
  // renders in this order and the first card is always the actionable one.
  const rank: Record<ConflictKind, number> = { block: 0, merge: 1, info: 2 };
  conflicts.sort((a, b) => rank[a.kind] - rank[b.kind] || b.overlap_count - a.overlap_count);

  return {
    blocked: conflicts.some((c) => c.kind === "block"),
    conflicts,
    candidate_match_count: candidateHits.length,
    candidate_samples: candidateHits.slice(0, MAX_CONFLICT_SAMPLES).map(toSample),
    candidate_level: candidateLevel,
  };
}
