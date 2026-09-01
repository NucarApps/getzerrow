// Shared types for the rules engine (Phase B).
//
// Everything here is plain data: the engine is pure, so its inputs are
// snapshots assembled by a caller (loadAccountContext today) and its
// output is a decision plus a trace. No Supabase, no AI, no clock.
import type { EmailForFilter } from "../sync/filter-engine";

/** The message shape the engine evaluates. Extends the filter-engine
 * shape with the fields the label-mirror and continuity stages need. */
export type EngineMessage = EmailForFilter & {
  /** Gmail label ids currently on the message. */
  raw_labels?: string[] | null;
  thread_id?: string | null;
};

/** A folder as the engine sees it. Deliberately narrower than the sync
 * `Folder` row: filing inputs only, and no `priority` — manual ordering
 * has no effect on filing (Amendment 2). */
export type EngineFolder = {
  id: string;
  name: string;
  /** false = paused: inert, never a destination, no side effects. */
  processing_enabled?: boolean;
  gmail_label_id?: string | null;
  /** Plain-language description the AI stage scores against. */
  description?: string | null;
  learned_profile?: string | null;
  /** Confidence floor for the AI stage. */
  min_ai_confidence?: number;
  skip_ai?: boolean;
};

export type Condition = { field: string; op: string; value: string };

/** Ladder levels, most specific first (Amendment 2). */
export type SpecificityLevel = 1 | 2 | 3 | 4 | 5;

/** A hard rule. `groups` is an OR of ANDs: the rule matches when every
 * condition of at least one group matches. Single-group rules are the
 * common case and the only shape the editor shows by default. */
export type Rule = {
  id: string;
  folder_id: string;
  /** ISO timestamp. Sole tiebreak of last resort: older rule wins. */
  created_at: string;
  groups: Condition[][];
  enabled?: boolean;
  /** Cached on the row in Phase D; derived when absent. */
  specificity_level?: SpecificityLevel;
};

/** An explicit user pin. Sender/domain/thread scoped, either "keep this in
 * the Inbox" or "always file this here". */
export type Pin = {
  id: string;
  kind: "inbox" | "folder";
  match: "email" | "domain" | "thread";
  value: string;
  folder_id?: string | null;
};

/** Stage-1 protection. `scope: "global"` pins the message to the Inbox and
 * stops the pipeline; `scope: "folder"` disqualifies that one folder for
 * every later stage (the shape today's folder exclusions have). */
export type Guardrail = {
  id: string;
  scope: "global" | "folder";
  kind: "exclusion" | "protected_sender" | "cold_email_contact";
  condition?: Condition;
  folder_id?: string | null;
  label?: string;
};

/** What an earlier message in the same thread resolved to. Continuity only
 * follows user placements and confirmed decisions — never an unconfirmed
 * AI placement (Amendment 1, stage 4). */
export type ThreadDecision = {
  folder_id: string | null;
  provenance: "user" | "confirmed" | "ai" | "rule";
};

export type Stage =
  "guardrail" | "pin" | "gmail_label" | "thread_continuity" | "rule" | "ai" | "inbox";

export type Trigger = "arrival" | "label_change" | "backfill" | "reprocess" | "replay" | "manual";

export type EvaluateContext = {
  folders: EngineFolder[];
  rules: Rule[];
  pins: Pin[];
  guardrails: Guardrail[];
  threadDecision?: ThreadDecision | null;
  /** Prior thread messages, for rules that evaluate across a thread. */
  threadMessages?: EngineMessage[];
  /** Override the built-in security/2FA detector (tests, tuning). */
  isSecurityMessage?: (m: EngineMessage) => boolean;
};

export type EvaluateOptions = {
  trigger: Trigger;
  /** Stage 6 runs only when true. Backfill, reprocess and replay pass
   * false — the AI stage is disabled on those paths (Amendment 1). */
  aiEnabled: boolean;
  /** trigger="label_change": the folder whose Gmail label just appeared. */
  labeledFolderId?: string | null;
  /** Ignore Gmail labels entirely (reprocess re-derives from rules). */
  skipGmailLabelMatch?: boolean;
};

// ─── Trace (Amendment 7) ─────────────────────────────────────────────────

export const RULES_TRACE_VERSION = 2 as const;

export type ConditionCheck = Condition & { passed: boolean };

export type RuleEvaluation = {
  rule_id: string;
  folder_id: string;
  folder_name: string;
  level: SpecificityLevel;
  matched: boolean;
  condition_count: number;
  /** Per-condition pass/fail of the first group (or the matching group). */
  conditions: ConditionCheck[];
};

export type StageTrace = {
  stage: Stage;
  outcome: "applied" | "skipped" | "pass";
  detail?: string;
};

export type Collision = {
  level: SpecificityLevel;
  winner_rule_id: string;
  loser_rule_ids: string[];
  folder_ids: string[];
  reason: string;
};

export type RulesTrace = {
  version: typeof RULES_TRACE_VERSION;
  trigger: Trigger;
  stages: StageTrace[];
  /** Every rule that matched, with its ladder level. */
  matched_rules: RuleEvaluation[];
  /** Up to 10 evaluated-but-failed rules with per-condition pass/fail. */
  failed_rules: RuleEvaluation[];
  winner?: { rule_id: string; folder_id: string; level: SpecificityLevel; reason: string };
  collision?: Collision;
  vetoed_folder_ids: string[];
  ai?: {
    eligible_folder_ids: string[];
    enabled: boolean;
  };
};

export type EvaluateResult = {
  folder_id: string | null;
  stage: Stage;
  /** True when stage 5 returned nothing and the AI stage may run. */
  needs_ai: boolean;
  ai_candidate_folder_ids: string[];
  reason: string;
  trace: RulesTrace;
};

export const MAX_TRACED_FAILED_RULES = 10;
