// Folder-write agreement suite.
//
// docs/rules-engine-audit.md §1 lists every code path that can set an
// email's folder and documents that several derive the decision on their
// own instead of going through the single writer — the concrete source of
// "same mailbox, different answer". This suite runs every INDEPENDENT
// decider over one shared set of mailbox scenarios
// (__fixtures__/folder-scenarios.ts) and asserts it agrees with the
// canonical ladder (classifyByRules → decide-folder.ts):
//
//   * the fixture's own `expect` — proves each scenario exercises the rung
//     it claims to (a scenario that stops matching fails here first),
//   * catchup (sync/catchup.ts buildCatchupRow) — the bulk manual-sync
//     write path,
//   * the v2 rules engine (rules/bridge.ts runRulesEngine), compared with
//     the same compareDecisions used by the production shadow mode — this
//     is the Phase E cutover seam,
//   * the ingest classifier (gmail/ingest-classify.ts), used by reprocess /
//     search-ingest / folder-scan — the path the audit flags as skipping
//     guardrail rungs.
//
// Divergences that exist BY DESIGN are declared per scenario
// (engineDelta / ingestDelta). An undeclared divergence fails; a declared
// divergence that silently stops diverging ALSO fails, so the table can
// never rot into wishful documentation.
//
// User-directed paths (manual move, domain reassign, scheduled actions,
// reconcile, classification feedback) are deliberate overrides of the
// ladder — they are not "deciders" and are covered by their own suites.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareDecisions } from "../rules/compare";
import { runRulesEngine } from "../rules/bridge";
import { classifyIngestedMessage } from "../gmail/ingest-classify";
import { buildCatchupRow } from "./catchup";
import {
  AUDIT_FOLDER_WRITE_PATHS,
  oracleDecision,
  scenarioContext,
  scenarioParsed,
  SCENARIOS,
  type FolderScenario,
} from "./__fixtures__/folder-scenarios";

describe("audit-path registry (docs/rules-engine-audit.md §1)", () => {
  it("covers all twelve folder-write paths, each by a suite that exists on disk", () => {
    const paths = AUDIT_FOLDER_WRITE_PATHS.map((p) => p.path).sort((a, b) => a - b);
    expect(paths).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const entry of AUDIT_FOLDER_WRITE_PATHS) {
      expect(entry.coveredBy.length, `path ${entry.path} (${entry.name})`).toBeGreaterThan(0);
      for (const file of entry.coveredBy) {
        expect(
          existsSync(join(process.cwd(), file)),
          `path ${entry.path} (${entry.name}): covering suite ${file} is missing — ` +
            "renamed or deleted without updating AUDIT_FOLDER_WRITE_PATHS",
        ).toBe(true);
      }
    }
  });
});

describe("scenario sanity: the oracle answers what each scenario claims", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", (_name, s) => {
    const oracle = oracleDecision(s);
    expect({ folder_id: oracle.folder_id, needs_ai: oracle.needs_ai }).toEqual(s.expect);
  });
});

describe("catchup (buildCatchupRow) agrees with the oracle", () => {
  const job = {
    id: "job-1",
    gmail_account_id: "acc-1",
    gmail_message_id: "g-1",
    user_id: "user-1",
    attempt: 0,
    priority: 0,
    published_at_ms: null,
  };

  function catchupParsed(s: FolderScenario) {
    const base = scenarioParsed(s);
    return {
      ...base,
      cc: base.cc ?? "",
      list_id: base.list_id ?? "",
      in_reply_to: base.in_reply_to ?? "",
      raw_labels: base.raw_labels ?? ["INBOX"],
      gmail_message_id: "g-1",
      thread_id: "t-1",
      reply_to_addr: null,
      origin_addr: null,
      origin_name: null,
      is_forwarded: false,
      has_calendar_invite: false,
      is_read: false,
    };
  }

  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", (_name, s) => {
    const oracle = oracleDecision(s);
    const built = buildCatchupRow(job, catchupParsed(s), scenarioContext(s));
    expect(built).not.toBeNull();
    if (oracle.needs_ai) {
      // AI-deferred mail is inserted provisional: pending_ai, no folder.
      expect(built!.needs_ai).toBe(true);
      expect(built!.folder_id).toBeNull();
      expect(built!.upsert.classified_by).toBe("pending_ai");
    } else {
      expect(built!.needs_ai).toBe(false);
      expect(built!.folder_id).toBe(oracle.folder_id);
      expect(built!.update?.folder_id ?? null).toBe(oracle.folder_id);
    }
  });
});

describe("v2 rules engine agrees with the legacy ladder (Phase E cutover seam)", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", (_name, s) => {
    const oracle = oracleDecision(s);
    const engine = runRulesEngine(scenarioParsed(s), scenarioContext(s), {
      trigger: "arrival",
      aiEnabled: true,
    });
    const verdict = compareDecisions(
      {
        folder_id: oracle.folder_id,
        classified_by: oracle.classified_by,
        needs_ai: oracle.needs_ai,
      },
      engine,
    );
    if (s.engineDelta) {
      // Declared amendment divergence: the engine must give exactly the
      // declared answer, and it must actually differ from the oracle —
      // if the two ever converge, the declaration is stale and must go.
      expect(engine.folder_id).toBe(s.engineDelta.folder_id);
      expect(verdict.agree).toBe(false);
    } else {
      expect(verdict, verdict.detail).toMatchObject({ agree: true });
    }
  });
});

describe("ingest classifier (reprocess / search-ingest path) vs the oracle", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", (_name, s) => {
    const oracle = oracleDecision(s);
    const email = scenarioParsed(s);
    const folders = s.folders ?? [];
    // Build labelToFolder the way BOTH production callers do
    // (reprocess.functions.ts and rules.functions.ts): paused folders never
    // enter the map — the paused rung lives in the callers, not in
    // classifyIngestedMessage itself. reprocess.functions.test.ts proves
    // this end-to-end.
    const labelToFolder = new Map(
      folders
        .filter((f) => f.gmail_label_id && f.processing_enabled !== false)
        .map((f) => [f.gmail_label_id!, f.id]),
    );
    const result = classifyIngestedMessage(
      {
        from_addr: email.from_addr,
        from_name: email.from_name,
        to_addrs: email.to_addrs,
        subject: email.subject,
        body_text: email.body_text,
        has_attachment: email.has_attachment,
        raw_labels: email.raw_labels,
      },
      {
        labelToFolder,
        folders,
        filters: s.filters ?? [],
        seedReason: "agreement-suite ingest",
      },
    );
    if (s.ingestDelta) {
      expect(result.folder_id).toBe(s.ingestDelta.folder_id);
    } else {
      expect(result.folder_id).toBe(oracle.folder_id);
    }
  });
});
