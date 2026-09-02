// Shared scenarios for the folder-write agreement suite
// (../folder-write-agreement.test.ts).
//
// Every code path that decides where an email is filed must give the same
// answer for the same mailbox state — docs/rules-engine-audit.md calls the
// historical failure "same mailbox, different answer". These scenarios are
// the common inputs; `oracleDecision` runs the canonical ladder
// (classifyByRules → decide-folder.ts) and each decider under test is
// asserted against it, with intentional divergences DECLARED per scenario
// (`engineDelta` for the v2 rules engine, `ingestDelta` for the ingest
// classifier) so an undeclared divergence — or a declared one that silently
// stops diverging — fails the suite.
//
// Negation appears twice on purpose: a FLAT folder_filters row with a
// not_contains/not_equals/domain_in op is an EXCLUSION (veto-only, never a
// positive match — filter-engine EXCLUDE_OPS), while the same op inside a
// filter_tree cond is a positive matcher. The "Fixed negation preview &
// cron" regression lived on exactly this seam.
//
// Lives in __fixtures__ so it is excluded from the `src/**/*.test.ts` glob
// and never ships: only test files import it.
import type { AccountContext } from "../account-context";
import { classifyByRules, type ParsedEmailForClassify } from "../classify";
import type { FolderDecision } from "../decide-folder";
import type { Filter, Folder, OverrideException } from "../types";
import {
  makeEmailRow,
  makeFolder,
  makeRule,
  type EmailRowFields,
} from "@/lib/__fixtures__/email-row";

export type FolderScenario = {
  name: string;
  email: Partial<EmailRowFields>;
  folders?: Folder[];
  filters?: Filter[];
  overrides?: Array<{ id: string; match_type: string; value: string }>;
  overrideExceptions?: OverrideException[];
  calendarGuardEnabled?: boolean;
  calendarContacts?: string[];
  /** What the oracle itself must return — keeps each scenario honest about
   * actually exercising the rung it claims to. */
  expect: { folder_id: string | null; needs_ai: boolean };
  /** Declared, intentional divergence of the v2 rules engine (an audit
   * amendment changed the behavior on purpose). Value = the engine's
   * expected folder_id, with the reason in `why`. Absent = the engine must
   * agree with the oracle. */
  engineDelta?: { folder_id: string | null; why: string };
  /** Declared divergence of the ingest classifier (reprocess/search-ingest
   * path): it implements only label-mirror + filter engine, so guardrail
   * rungs the oracle applies are missing there. Absent = must agree on
   * destination. */
  ingestDelta?: { folder_id: string | null; why: string };
};

/** Build a fresh ParsedEmailForClassify. Fresh per call because
 * decide-folder mutates `sender_group_ids` on the object it is handed. */
export function scenarioParsed(s: FolderScenario): ParsedEmailForClassify {
  return makeEmailRow(s.email);
}

/** Build a fresh AccountContext for one scenario. */
export function scenarioContext(s: FolderScenario): AccountContext {
  return {
    folders: s.folders ?? [],
    filters: s.filters ?? [],
    overrides: s.overrides ?? [],
    overrideExceptions: s.overrideExceptions ?? [],
    enrichedFolders: [],
    calendarGuardEnabled: s.calendarGuardEnabled ?? false,
    calendarContacts: new Set(s.calendarContacts ?? []),
    accountEmail: "me@example.com",
    senderGroups: new Map(),
  };
}

/** The canonical answer: the full deterministic ladder, arrival trigger. */
export function oracleDecision(s: FolderScenario): FolderDecision {
  return classifyByRules(scenarioParsed(s), scenarioContext(s), { trigger: "arrival" });
}

// ─── Building blocks ─────────────────────────────────────────────────────
// Fresh objects per scenario so a mutation in one decider run can never
// leak into another.

const work = () => makeFolder({ id: "f-work", name: "Work", priority: 10 });
const news = () => makeFolder({ id: "f-news", name: "Newsletters", priority: 5 });
const aiOnly = () => makeFolder({ id: "f-ai", name: "AI Only", ai_rule: "interesting mail" });

export const SCENARIOS: FolderScenario[] = [
  {
    // NOTE `from` matches against "addr name", so `equals` on a bare
    // address never fires — `contains` is the op real sender rules use.
    name: "exact-sender rule files into its folder",
    email: { from_addr: "boss@acme.com" },
    folders: [work(), aiOnly()],
    filters: [makeRule("f-work", "from", "contains", "boss@acme.com")],
    expect: { folder_id: "f-work", needs_ai: false },
  },
  {
    name: "domain rule files into its folder",
    email: { from_addr: "noreply@news.test" },
    folders: [news(), aiOnly()],
    filters: [makeRule("f-news", "domain", "contains", "news.test")],
    expect: { folder_id: "f-news", needs_ai: false },
  },
  {
    name: "flat not_contains row is an exclusion — never a positive match",
    email: { from_addr: "person@client.com", subject: "hello" },
    folders: [work(), aiOnly()],
    filters: [makeRule("f-work", "from", "not_contains", "@internal.test")],
    // The veto doesn't fire (sender doesn't contain the value), but an
    // exclusion row alone can never FILE mail either — falls to AI.
    expect: { folder_id: null, needs_ai: true },
  },
  {
    name: "flat not_contains veto fires — folder also drops out of AI eligibility",
    email: { from_addr: "person@internal.test" },
    folders: [work()],
    filters: [makeRule("f-work", "from", "not_contains", "@internal.test")],
    // Work's exclusion vetoes this sender, and a vetoed folder is not an
    // AI candidate (aiCandidateIds) — nothing left, stays in inbox.
    expect: { folder_id: null, needs_ai: false },
  },
  {
    name: "not_contains inside a filter_tree is a positive matcher",
    email: { from_addr: "person@client.com" },
    folders: [
      makeFolder({
        id: "f-work",
        name: "Work",
        filter_tree: {
          type: "group",
          op: "and",
          children: [{ type: "cond", field: "from", op: "not_contains", value: "@internal.test" }],
        },
      }),
    ],
    filters: [],
    expect: { folder_id: "f-work", needs_ai: false },
  },
  {
    name: "two folders match — priority resolves the tie",
    email: { from_addr: "sales@vendor.com" },
    folders: [work(), news()],
    filters: [
      makeRule("f-work", "domain", "contains", "vendor.com"),
      makeRule("f-news", "domain", "contains", "vendor.com"),
    ],
    expect: { folder_id: "f-work", needs_ai: false },
    engineDelta: {
      folder_id: "f-news",
      why:
        "Amendment 2: the engine drops folders.priority as an input. Both " +
        "rules are same-level L3 with equal created_at (flat rules adapt " +
        "to the epoch), so the resolver falls to rule-id order — a " +
        "recorded collision, where legacy silently used priority",
    },
  },
  {
    name: "Gmail label linked to a folder files it at sync time",
    email: { from_addr: "any@one.test", raw_labels: ["INBOX", "Label_work"] },
    folders: [makeFolder({ id: "f-work", name: "Work", gmail_label_id: "Label_work" }), aiOnly()],
    filters: [],
    expect: { folder_id: "f-work", needs_ai: false },
  },
  {
    name: "Gmail label of a PAUSED folder never files",
    email: { from_addr: "any@one.test", raw_labels: ["INBOX", "Label_paused"] },
    folders: [
      makeFolder({
        id: "f-paused",
        name: "Paused",
        processing_enabled: false,
        gmail_label_id: "Label_paused",
        ai_rule: null,
      }),
    ],
    filters: [],
    // No ingestDelta: classifyIngestedMessage has no paused rung itself,
    // but both production callers exclude paused folders when building
    // labelToFolder (and the agreement test mirrors them), so the ingest
    // path agrees with the oracle here end-to-end.
    expect: { folder_id: null, needs_ai: false },
  },
  {
    name: "Gmail label vetoed by the folder's own exclusion rule",
    email: { from_addr: "spam@bad.test", raw_labels: ["INBOX", "Label_work"] },
    folders: [
      makeFolder({ id: "f-work", name: "Work", gmail_label_id: "Label_work", ai_rule: null }),
    ],
    filters: [makeRule("f-work", "from", "not_contains", "@bad.test")],
    expect: { folder_id: null, needs_ai: false },
    ingestDelta: {
      folder_id: "f-work",
      why: "ingest label mirror skips the folder's own exclusion veto",
    },
  },
  {
    name: "inbox override (always-inbox pin) beats a matching rule",
    email: { from_addr: "ceo@acme.com" },
    folders: [work()],
    filters: [makeRule("f-work", "domain", "contains", "acme.com")],
    overrides: [{ id: "ov-1", match_type: "email", value: "ceo@acme.com" }],
    expect: { folder_id: null, needs_ai: false },
    ingestDelta: {
      folder_id: "f-work",
      why: "ingest classifier has no inbox-override rung — files anyway",
    },
  },
  {
    name: "domain-wide inbox override pins the whole domain",
    email: { from_addr: "anyone@vip.test" },
    folders: [work()],
    filters: [makeRule("f-work", "domain", "contains", "vip.test")],
    overrides: [{ id: "ov-2", match_type: "domain", value: "vip.test" }],
    expect: { folder_id: null, needs_ai: false },
    ingestDelta: {
      folder_id: "f-work",
      why: "ingest classifier has no inbox-override rung — files anyway",
    },
  },
  {
    name: "folder with overrides_inbox_override beats the always-inbox pin",
    email: { from_addr: "ceo@acme.com" },
    folders: [makeFolder({ id: "f-work", name: "Work", overrides_inbox_override: true })],
    filters: [makeRule("f-work", "from", "contains", "ceo@acme.com")],
    overrides: [{ id: "ov-1", match_type: "email", value: "ceo@acme.com" }],
    // Ingest agrees on the destination here, but only because it never saw
    // the pin at all — the pin-vs-folder arbitration is oracle-only.
    expect: { folder_id: "f-work", needs_ai: false },
  },
  {
    name: "override exception lets a matching rule file past the pin",
    email: { from_addr: "ceo@acme.com", subject: "Invoice attached" },
    folders: [work()],
    filters: [makeRule("f-work", "subject", "contains", "Invoice")],
    overrides: [{ id: "ov-1", match_type: "email", value: "ceo@acme.com" }],
    overrideExceptions: [
      { override_id: "ov-1", field: "subject", op: "contains", value: "Invoice" },
    ],
    expect: { folder_id: "f-work", needs_ai: false },
  },
  {
    name: "exclusion veto keeps the email out and skips AI",
    email: { from_addr: "noreply@news.test", subject: "unsubscribe digest" },
    folders: [news()],
    filters: [
      makeRule("f-news", "domain", "contains", "news.test"),
      makeRule("f-news", "subject", "not_contains", "unsubscribe"),
    ],
    expect: { folder_id: null, needs_ai: false },
  },
  {
    name: "no rule matches, AI-eligible folder exists — defers to AI",
    email: { from_addr: "stranger@nowhere.test" },
    folders: [aiOnly()],
    filters: [],
    expect: { folder_id: null, needs_ai: true },
  },
  {
    name: "no rule matches and no AI-eligible folder — stays in inbox",
    email: { from_addr: "stranger@nowhere.test" },
    folders: [makeFolder({ id: "f-work", name: "Work", ai_rule: null })],
    filters: [],
    expect: { folder_id: null, needs_ai: false },
  },
  {
    name: "paused folder's rule never files",
    email: { from_addr: "person@paused.test" },
    folders: [
      makeFolder({ id: "f-paused", name: "Paused", processing_enabled: false, priority: 99 }),
    ],
    filters: [makeRule("f-paused", "domain", "contains", "paused.test")],
    expect: { folder_id: null, needs_ai: false },
  },
  {
    name: "calendar guard keeps a known contact out of a cold-email folder",
    email: { from_addr: "met@calendar.test" },
    folders: [makeFolder({ id: "f-cold", name: "Cold Email", is_cold_email: true, ai_rule: null })],
    filters: [makeRule("f-cold", "domain", "contains", "calendar.test")],
    calendarGuardEnabled: true,
    calendarContacts: ["met@calendar.test"],
    // The engine agrees on the destination but gets there differently: the
    // guard is a stage-1 folder guardrail there (Amendment 1) rather than a
    // post-filter check on the winning folder, so the cold folder is out of
    // play before any stage — including AI — can reach it.
    expect: { folder_id: null, needs_ai: false },
    ingestDelta: {
      folder_id: "f-cold",
      why: "ingest classifier has no calendar-guard rung — files anyway",
    },
  },
];

// ─── Audit-path registry ─────────────────────────────────────────────────
// docs/rules-engine-audit.md §1: the twelve code paths that can write
// emails.folder_id. Every path must be held to a suite — agreement with the
// oracle for rule-derived paths, an explicit contract for user-directed and
// mirror paths. folder-write-agreement.test.ts enforces that every entry
// below exists on disk, so removing or renaming a covering suite (or adding
// a path without registering it) fails loudly instead of rotting silently.
export const AUDIT_FOLDER_WRITE_PATHS: Array<{
  path: number;
  name: string;
  /** Repo-relative test files holding this path to its suite. */
  coveredBy: string[];
  /** Repo-relative source files that actually write `emails.folder_id` for
   * this path. folder-write-agreement.test.ts scans src/ for write sites
   * and fails when one appears in a file listed by no path — that is how a
   * new decider gets noticed instead of quietly filing mail on its own. */
  writers: string[];
}> = [
  {
    path: 1,
    name: "arrival (process-message)",
    coveredBy: ["src/lib/sync/folder-write-agreement.pipeline.test.ts"],
    writers: ["src/lib/sync/process-message.ts", "src/lib/sync/apply-decision.ts"],
  },
  {
    path: 2,
    name: "AI second pass (classify)",
    coveredBy: ["src/lib/sync/folder-write-agreement.pipeline.test.ts"],
    writers: ["src/lib/sync/run-jobs.ts"],
  },
  {
    path: 3,
    name: "Gmail label mirror (history label_change)",
    coveredBy: ["src/lib/sync/folder-write-agreement.pipeline.test.ts"],
    writers: ["src/lib/sync/folder-learn.ts"],
  },
  {
    path: 4,
    name: "backfill / catch-up",
    // catchup directly (buildCatchupRow); backfill.ts delegates to
    // processGmailMessage, so its ladder is covered by the pipeline suite.
    coveredBy: [
      "src/lib/sync/folder-write-agreement.test.ts",
      "src/lib/sync/folder-write-agreement.pipeline.test.ts",
    ],
    writers: ["src/lib/sync/catchup.ts"],
  },
  {
    path: 5,
    name: "rescue pass",
    coveredBy: ["src/lib/sync/folder-write-agreement.pipeline.test.ts"],
    writers: ["src/lib/sync/rescue.ts"],
  },
  {
    path: 6,
    name: "reprocess / reanalyze (+ search ingest)",
    coveredBy: [
      "src/lib/sync/folder-write-agreement.test.ts",
      "src/lib/gmail/reprocess.functions.test.ts",
    ],
    writers: ["src/lib/gmail/reprocess.functions.ts", "src/lib/gmail/move.functions.ts"],
  },
  {
    path: 7,
    name: "rule actions / apply rule now (rules.functions)",
    coveredBy: ["src/lib/gmail/rules.functions.test.ts"],
    writers: ["src/lib/gmail/rules.functions.ts"],
  },
  {
    path: 8,
    name: "domain move tooling",
    coveredBy: ["src/lib/gmail/domain.functions.test.ts"],
    writers: ["src/lib/gmail/domain.functions.ts"],
  },
  {
    path: 9,
    name: "manual move / strip",
    coveredBy: [
      "src/lib/sync/folder-write-contracts.test.ts",
      "src/lib/gmail/move.functions.test.ts",
    ],
    writers: [
      "src/lib/move-email.server.ts",
      "src/lib/gmail-helpers.server.ts",
      "src/lib/gmail/folder-mgmt.functions.ts",
    ],
  },
  {
    path: 10,
    name: "scheduled actions",
    coveredBy: ["src/lib/sync/folder-write-contracts.test.ts"],
    writers: ["src/lib/sync/scheduled-actions.ts"],
  },
  {
    path: 11,
    name: "reconcile",
    coveredBy: ["src/lib/sync/reconcile.test.ts"],
    writers: ["src/lib/sync/reconcile.ts"],
  },
  {
    path: 12,
    name: "classification feedback",
    coveredBy: ["src/lib/sync/folder-write-contracts.test.ts"],
    writers: ["src/lib/sync/classification-feedback.functions.ts"],
  },
  {
    // Not in the original audit: found by the write-site scan below. The
    // rule-change planner applies its preview through performMove, but it
    // owns the refusal rules (foreign row, placed_by_user, unchanged) and
    // the restore-to-Inbox branch, so it gets its own contract.
    path: 13,
    name: "rule-change planner apply",
    coveredBy: ["src/lib/rules/planner-apply.server.test.ts"],
    writers: ["src/lib/rules/planner-apply.server.ts"],
  },
];

/** Source files that legitimately mention a folder_id write but are not a
 * filing path: the shared encrypted writer itself, and test-only data. */
export const FOLDER_WRITE_SCAN_EXEMPT = ["src/lib/sync/encrypted-writer.ts"];
