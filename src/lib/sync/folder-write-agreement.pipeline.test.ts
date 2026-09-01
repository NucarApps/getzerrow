// Folder-write agreement suite — PIPELINE half.
//
// The sibling folder-write-agreement.test.ts holds each INDEPENDENT
// decider (catchup builder, v2 engine, ingest classifier) to the canonical
// ladder as pure functions. This file covers the remaining audit paths
// (docs/rules-engine-audit.md §1) END TO END, driving the REAL pipeline
// entry points over the same shared scenarios
// (__fixtures__/folder-scenarios.ts) and asserting the PERSISTED
// folder_id — not just the in-memory decision — agrees with the oracle
// (classifyByRules → decide-folder.ts):
//
//   * path 1 — arrival: processGmailMessage (sync/process-message.ts),
//   * path 2 — AI second pass: classifyByAi via processGmailMessage
//     (sync/classify.ts), including the aiCandidateIds gating seam,
//   * path 3 — Gmail label change: syncSinceHistory's label mirror
//     (sync/history.ts applyLabelChange), compared against the ladder
//     under trigger "label_change",
//   * path 5 — rescue: rescueStrandedEmails (sync/rescue.ts), rules stage
//     plus its separate AI confidence gate (audit §2 bullet 3).
//
// This is ONE file, not one per path, because all four paths share a
// single file-scoped mock arrangement — the supabase fake plus mocks for
// gmail.server / ai.server / encrypted-writer / account-context — and
// none of the per-path mocks conflict (the gmail.server mock simply
// exports the union of what process-message and history need). Only the
// classification layer itself (classify.ts, decide-folder.ts,
// filter-engine.ts, apply-decision.ts) is kept REAL — that is the point.
//
// Characterization only: where a live path DISAGREES with the oracle the
// test pins ACTUAL behavior under a loud `// DIVERGENCE (audit §…)`
// comment, styled like the fixture's engineDelta declarations — if the
// divergence is ever fixed, the pin fails and must be deleted, so the
// suite can never rot into wishful documentation.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

// Property accesses are deferred into method bodies so the hoisted factory
// never touches `fake` before its initializer runs.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

// ─── gmail.server: union of what process-message and history import ─────
type HistoryPage = {
  historyId?: string;
  history?: Array<Record<string, unknown>>;
  nextPageToken?: string;
};
const listHistoryQueue: Array<HistoryPage | Error> = [];
const modifyMessage = vi.fn(async (..._args: unknown[]) => ({}));
const sendMessage = vi.fn(async (..._args: unknown[]) => ({}));

vi.mock("../gmail.server", () => {
  class GmailApiError extends Error {
    status: number;
    retryable: boolean;
    constructor(message: string, status: number, retryable: boolean) {
      super(message);
      this.name = "GmailApiError";
      this.status = status;
      this.retryable = retryable;
    }
  }
  return {
    GmailApiError,
    // Path 1 always passes `prefetched`; a raw fetch/parse here would mean
    // the test drove the pipeline through an unintended door.
    async getMessage() {
      throw new Error("getMessage must not be called — pass prefetched");
    },
    parseMessage() {
      throw new Error("parseMessage must not be called — pass prefetched");
    },
    modifyMessage: (...args: unknown[]) => modifyMessage(...args),
    sendMessage: (...args: unknown[]) => sendMessage(...args),
    async listHistory() {
      const next = listHistoryQueue.shift();
      if (next instanceof Error) throw next;
      return next ?? { historyId: "1000", history: [] };
    },
    async listMessages() {
      return { messages: [] };
    },
    async getMessageMetadata() {
      return {};
    },
    async ensureWatch() {
      return null;
    },
  };
});

// ─── ai.server: the ONLY nondeterministic dependency of the real ladder ──
const classifyEmail = vi.fn(async (..._args: unknown[]) => ({
  folder_id: null as string | null,
  confidence: 0,
  summary: "",
  reason: "",
}));
const classifyEmailsBatch = vi.fn(async (emails: unknown[], _folders: unknown) =>
  emails.map(() => ({ folder_id: null as string | null, confidence: 0, summary: "", reason: "" })),
);
vi.mock("../ai.server", () => ({
  classifyEmail: (...args: unknown[]) => classifyEmail(...args),
  classifyEmailsBatch: (emails: unknown[], folders: unknown) =>
    classifyEmailsBatch(emails, folders),
  shouldSurfaceToInbox: async () => ({ surface: false, reason: "" }),
}));

// ─── persistence seams: capture what each path actually writes ──────────
const upsertEmailEncrypted = vi.fn(
  async (_input: unknown) =>
    ({ id: "email-1", error: null }) as { id: string | null; error: string | null },
);
const updateEmailEncrypted = vi.fn(async (_input: unknown) => ({ error: null as string | null }));
vi.mock("./encrypted-writer", () => ({
  upsertEmailEncrypted: (input: unknown) => upsertEmailEncrypted(input),
  updateEmailEncrypted: (input: unknown) => updateEmailEncrypted(input),
}));

const getEmailsDecrypted = vi.fn(async (ids: string[]) => ({
  rows: ids.map((id) => ({ id })),
  error: null as string | null,
}));
vi.mock("./encrypted-reader", () => ({
  getEmailsDecrypted: (ids: string[]) => getEmailsDecrypted(ids),
}));

const loadAccountContext = vi.fn();
vi.mock("./account-context", () => ({
  loadAccountContext: (accountId: string, userId: string) => loadAccountContext(accountId, userId),
}));

const recordManualMove = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./folder-learn", () => ({
  bumpEmailsSinceLearn: async (_folderId: string) => {},
  recordManualMove: (...args: unknown[]) => recordManualMove(...args),
}));

vi.mock("./executed-rules", () => ({ recordExecution: async (_input: unknown) => {} }));
vi.mock("../push.server", () => ({ notifyInboxMail: async (..._args: unknown[]) => {} }));
vi.mock("./enqueue", () => ({ enqueueMessageJobs: async (..._args: unknown[]) => {} }));
vi.mock("./backfill", () => ({ backfillRecent: async (..._args: unknown[]) => {} }));
vi.mock("../log.server", () => ({
  logError: () => {},
  logInfo: () => {},
  logMetric: () => {},
  logAudit: () => {},
  newRunId: () => "test-run",
}));

import { processGmailMessage } from "./process-message";
import { syncSinceHistory } from "./history";
import { rescueStrandedEmails } from "./rescue";
import { aiCandidateIds, decideFolder } from "./decide-folder";
import type { AccountContext } from "./account-context";
import { makeFolder, makeRule } from "@/lib/__fixtures__/email-row";
import {
  oracleDecision,
  scenarioContext,
  scenarioParsed,
  SCENARIOS,
  type FolderScenario,
} from "./__fixtures__/folder-scenarios";

const ACC = "acc-1"; // matches makeFolder's default gmail_account_id
const USER = "user-1";
const GMAIL_ID = "gm-1";

type GmailServer = typeof import("../gmail.server");
type Parsed = ReturnType<GmailServer["parseMessage"]>;

function byName(name: string): FolderScenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`scenario not found: ${name}`);
  return s;
}

/** A scenario's email as the full parsed-Gmail-message shape the live
 * pipeline hands processGmailMessage via `prefetched`. */
function pipelineParsed(s: FolderScenario): Parsed {
  const base = scenarioParsed(s);
  return {
    gmail_message_id: GMAIL_ID,
    thread_id: "t-1",
    from_addr: base.from_addr,
    from_name: base.from_name,
    to_addrs: base.to_addrs,
    cc: base.cc ?? "",
    list_id: base.list_id ?? "",
    in_reply_to: base.in_reply_to ?? "",
    reply_to_addr: null,
    origin_addr: null,
    origin_name: null,
    is_forwarded: false,
    subject: base.subject,
    snippet: base.snippet,
    body_text: base.body_text,
    body_html: base.body_html,
    received_at: base.received_at,
    has_attachment: base.has_attachment,
    has_calendar_invite: false,
    raw_labels: base.raw_labels ?? ["INBOX"],
    is_read: false,
  };
}

/** scenarioContext leaves enrichedFolders empty (the deterministic oracle
 * never reads them); the AI rung does, so pipeline runs that reach it get
 * the same enrichment loadAccountContext performs in production. */
function contextWithAi(s: FolderScenario): AccountContext {
  const ctx = scenarioContext(s);
  return {
    ...ctx,
    enrichedFolders: ctx.folders.map((f) => ({ id: f.id, name: f.name, ai_rule: f.ai_rule })),
  };
}

/** Every encrypted-writer UPDATE that carried a folder decision. */
function folderWrites(): Array<Record<string, unknown>> {
  return updateEmailEncrypted.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((p) => !!p && "folder_id" in p);
}

function emailTableUpdates() {
  return fake.calls.updates.filter((u) => u.table === "emails");
}

beforeEach(() => {
  fake.reset();
  listHistoryQueue.length = 0;
  modifyMessage.mockResolvedValue({});
  sendMessage.mockResolvedValue({});
  classifyEmail.mockResolvedValue({ folder_id: null, confidence: 0, summary: "", reason: "" });
  classifyEmailsBatch.mockImplementation(async (emails: unknown[]) =>
    emails.map(() => ({ folder_id: null, confidence: 0, summary: "", reason: "" })),
  );
  upsertEmailEncrypted.mockResolvedValue({ id: "email-1", error: null });
  updateEmailEncrypted.mockResolvedValue({ error: null });
  getEmailsDecrypted.mockImplementation(async (ids: string[]) => ({
    rows: ids.map((id) => ({ id })),
    error: null,
  }));
  loadAccountContext.mockImplementation(async () =>
    scenarioContext({ name: "", email: {}, expect: { folder_id: null, needs_ai: false } }),
  );
});

// ─── Path 1 — arrival ────────────────────────────────────────────────────
// processGmailMessage runs the REAL classifyByRules before the insert and
// persists through persistDecision. skipAi keeps the run deterministic:
// needs_ai mail must land as a provisional pending_ai row with NO folder
// write, exactly like the backfill lane.
describe("path 1 — arrival: processGmailMessage persists the oracle's decision", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", async (_name, s) => {
    const oracle = oracleDecision(s);
    loadAccountContext.mockImplementation(async () => scenarioContext(s));

    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: pipelineParsed(s),
      skipAi: true,
      skipPush: true,
    });

    if (oracle.needs_ai) {
      expect(res).toMatchObject({ folder_id: null, needs_ai: true });
      expect(upsertEmailEncrypted).toHaveBeenCalledWith(
        expect.objectContaining({ classified_by: "pending_ai" }),
      );
      // Provisional row: nothing may write a folder until the AI pass.
      expect(folderWrites()).toHaveLength(0);
    } else {
      expect(res).toMatchObject({ folder_id: oracle.folder_id, needs_ai: false });
      // The single INSERT already carries the oracle's classified_by…
      expect(upsertEmailEncrypted).toHaveBeenCalledWith(
        expect.objectContaining({ classified_by: oracle.classified_by }),
      );
      // …and persistDecision writes the oracle's folder (null = stays put).
      const writes = folderWrites();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        email_id: "email-1",
        folder_id: oracle.folder_id,
        classified_by: oracle.classified_by,
      });
    }
  });
});

// ─── Path 2 — AI second pass ─────────────────────────────────────────────
// classifyByAi finishes the ladder for needs_ai mail. decide-folder's
// aiCandidateIds is the single eligibility rung ("the AI must never place
// mail where the folder's rules reject it") — it gates which folders are
// OFFERED to the gateway, and these tests characterize whether it also
// gates the ANSWER.
describe("path 2 — AI second pass: classifyByAi through processGmailMessage", () => {
  it("persists an eligible above-threshold AI answer, offering ONLY aiCandidateIds folders", async () => {
    const s = byName("no rule matches, AI-eligible folder exists — defers to AI");
    expect(oracleDecision(s).needs_ai).toBe(true); // scenario sanity
    loadAccountContext.mockImplementation(async () => contextWithAi(s));
    classifyEmail.mockResolvedValueOnce({
      folder_id: "f-ai",
      confidence: 0.9,
      summary: "sum",
      reason: "fits the rule",
    });

    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: pipelineParsed(s),
      skipPush: true,
    });

    expect(res).toMatchObject({ folder_id: "f-ai", needs_ai: false });
    // The candidate list handed to the gateway is exactly the eligible set.
    const offered = classifyEmail.mock.calls[0]![1] as Array<{ id: string }>;
    expect(offered.map((f) => f.id)).toEqual(["f-ai"]);
    expect(updateEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({
        email_id: "email-1",
        folder_id: "f-ai",
        classified_by: "ai",
        ai_confidence: 0.9,
      }),
    );
  });

  it("an AI answer naming a NON-eligible (vetoed) folder is persisted anyway — pinned", async () => {
    // Local scenario (same building blocks as the shared set): f-work's
    // flat not_contains row vetoes this sender, so f-work is OUT of
    // aiCandidateIds; f-ai remains eligible → needs_ai.
    const s: FolderScenario = {
      name: "vetoed folder still exists in context",
      email: { from_addr: "person@internal.test" },
      folders: [
        makeFolder({ id: "f-work", name: "Work", priority: 10 }),
        makeFolder({ id: "f-ai", name: "AI Only", ai_rule: "interesting mail" }),
      ],
      filters: [makeRule("f-work", "from", "not_contains", "@internal.test")],
      expect: { folder_id: null, needs_ai: true },
    };
    expect(oracleDecision(s)).toMatchObject(s.expect); // scenario sanity
    const eligible = aiCandidateIds(scenarioParsed(s), scenarioContext(s));
    expect(eligible.has("f-work")).toBe(false); // vetoed for this sender
    expect(eligible.has("f-ai")).toBe(true);

    loadAccountContext.mockImplementation(async () => contextWithAi(s));
    // The gateway answers with the folder it was never offered.
    classifyEmail.mockResolvedValueOnce({
      folder_id: "f-work",
      confidence: 0.99,
      summary: "sum",
      reason: "looks like work",
    });

    const res = await processGmailMessage(ACC, GMAIL_ID, USER, {
      prefetched: pipelineParsed(s),
      skipPush: true,
    });

    // Only the eligible folder was OFFERED…
    const offered = classifyEmail.mock.calls[0]![1] as Array<{ id: string }>;
    expect(offered.map((f) => f.id)).toEqual(["f-ai"]);
    // DIVERGENCE (audit §1 path 2; decide-folder.ts aiCandidateIds doc:
    // "the AI must never place mail where the folder's rules reject it"):
    // classifyByRules/aiCandidateIds gate only the candidate list SENT to
    // the gateway — classifyByAi (classify.ts:131-140) never validates the
    // ANSWER against that set. A hallucinated or non-eligible folder_id is
    // looked up in context.folders just for its min_ai_confidence
    // (unknown folder → threshold 0) and is then PERSISTED. Here the
    // vetoed f-work is filed at 0.99 despite its own exclusion rule.
    // If this pin fails because folder_id is null / f-ai, the gate was
    // fixed — update the divergence note and this assertion.
    expect(res).toMatchObject({ folder_id: "f-work", needs_ai: false });
    expect(updateEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({ email_id: "email-1", folder_id: "f-work", classified_by: "ai" }),
    );
  });
});

// ─── Path 3 — Gmail label change (history label mirror) ──────────────────
// syncSinceHistory's applyLabelChange patches emails directly
// (history.ts:486-492) instead of entering the ladder as trigger
// "label_change" — audit §1 path 3 ("partially — patches emails directly").
// The ladder's label_change oracle:
function labelChangeOracle(s: FolderScenario, labeledFolderId: string) {
  return decideFolder(scenarioParsed(s), scenarioContext(s), {
    trigger: "label_change",
    labeledFolderId,
  });
}

function seedLabelChange(s: FolderScenario, addedLabelId: string) {
  fake.seed("gmail_accounts", [
    {
      id: ACC,
      user_id: USER,
      email_address: "me@example.com",
      history_id: "1000",
      watch_expiration: null,
    },
  ]);
  fake.seed(
    "folders",
    (s.folders ?? []).map((f) => ({ ...f })),
  );
  fake.seed("emails", [
    { id: "row-1", gmail_account_id: ACC, gmail_message_id: "m-1", folder_id: null },
  ]);
  listHistoryQueue.push({
    historyId: "1100",
    history: [
      {
        id: "1010",
        labelsAdded: [{ message: { id: "m-1", labelIds: ["INBOX"] }, labelIds: [addedLabelId] }],
      },
    ],
  });
}

function mirrorPatch(): Record<string, unknown> {
  const patch = emailTableUpdates().find((u) => "folder_id" in (u.payload as object));
  expect(patch).toBeDefined();
  return patch!.payload as Record<string, unknown>;
}

describe("path 3 — label mirror: syncSinceHistory vs the label_change oracle", () => {
  it("a live folder's label files into it — mirror and oracle agree", async () => {
    const s = byName("Gmail label linked to a folder files it at sync time");
    const oracle = labelChangeOracle(s, "f-work");
    expect(oracle).toMatchObject({ folder_id: "f-work", classified_by: "gmail_labeled" });

    seedLabelChange(s, "Label_work");
    await syncSinceHistory(ACC);

    const patch = mirrorPatch();
    expect(patch).toMatchObject({ folder_id: "f-work", classified_by: "gmail_labeled" });
    expect(patch.folder_id).toBe(oracle.folder_id);
  });

  it("a PAUSED folder's label still files it — pinned against the oracle's paused rung", async () => {
    const s = byName("Gmail label of a PAUSED folder never files");
    const oracle = labelChangeOracle(s, "f-paused");
    expect(oracle.folder_id).toBeNull(); // rung 1: paused is never a destination

    seedLabelChange(s, "Label_paused");
    await syncSinceHistory(ACC);

    // DIVERGENCE (audit §1 path 3, §2 "vetoes run after filing", §3
    // "side-effect skips (paused folder) are logged, not stored"):
    // history.ts's paused-folder filter (history.ts:154-159) guards only
    // the LEARNING side (recordManualMove); applyLabelChange's mirror
    // still writes folder_id for a paused folder's label. decide-folder's
    // rung-1 comment says "the OLD mirror wrote folder_id anyway" — the
    // live mirror STILL does. If this pin fails with no folder write, the
    // mirror was routed through the ladder — delete this divergence.
    const patch = mirrorPatch();
    expect(patch).toMatchObject({ folder_id: "f-paused", classified_by: "gmail_labeled" });
    expect(patch.folder_id).not.toBe(oracle.folder_id);
    // The pause DOES suppress learning — only filing leaks through.
    expect(recordManualMove).not.toHaveBeenCalled();
  });

  it("a label on a folder whose own exclusion vetoes the sender still files — pinned", async () => {
    const s = byName("Gmail label vetoed by the folder's own exclusion rule");
    const oracle = labelChangeOracle(s, "f-work");
    expect(oracle.folder_id).toBeNull(); // rung 2: the folder's veto wins

    seedLabelChange(s, "Label_work");
    await syncSinceHistory(ACC);

    // DIVERGENCE (audit §1 path 3): applyLabelChange never consults
    // folder_filters at all — the label→folder map is the whole decision,
    // so the folder's own not_contains exclusion (which the ladder applies
    // at rung 2 even for label_change) is skipped and the vetoed sender is
    // filed anyway.
    const patch = mirrorPatch();
    expect(patch).toMatchObject({ folder_id: "f-work", classified_by: "gmail_labeled" });
    expect(patch.folder_id).not.toBe(oracle.folder_id);
  });
});

// ─── Path 5 — rescue ─────────────────────────────────────────────────────
// rescueStrandedEmails re-runs the REAL classifyByRules over stranded rows
// (folder_id null, pending_ai) and finalizes through its own patch shape.
function seedStrandedScenario(s: FolderScenario) {
  const parsed = scenarioParsed(s);
  fake.seed("emails", [
    {
      id: "e1",
      user_id: USER,
      gmail_account_id: ACC,
      gmail_message_id: "gm-e1",
      from_addr: parsed.from_addr,
      list_id: parsed.list_id ?? null,
      in_reply_to: parsed.in_reply_to ?? null,
      reply_to_addr: null,
      origin_addr: null,
      has_attachment: parsed.has_attachment,
      received_at: parsed.received_at,
      raw_labels: parsed.raw_labels,
      classify_attempts: 0,
      folder_id: null,
      classified_by: "pending_ai",
      created_at: new Date(Date.now() - 60_000).toISOString(),
    },
  ]);
  getEmailsDecrypted.mockImplementation(async (ids: string[]) => ({
    rows: ids.map((id) => ({
      id,
      from_name: parsed.from_name,
      to_addrs: parsed.to_addrs,
      cc: parsed.cc ?? null,
      subject: parsed.subject,
      snippet: parsed.snippet,
      body_text: parsed.body_text,
    })),
    error: null,
  }));
  loadAccountContext.mockImplementation(async () => contextWithAi(s));
}

describe("path 5 — rescue: rules stage agrees with the oracle", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", async (_name, s) => {
    const oracle = oracleDecision(s);
    seedStrandedScenario(s);

    const res = await rescueStrandedEmails();
    expect(res).toMatchObject({ scanned: 1, rescued: 1, failed: 0, skipped: 0 });

    if (oracle.needs_ai) {
      // Rules stage agreed the row needs AI and deferred to the batch
      // (whose default answer here is "no folder" → terminal ai outcome).
      expect(classifyEmailsBatch).toHaveBeenCalledTimes(1);
      expect(updateEmailEncrypted).toHaveBeenCalledWith(
        expect.objectContaining({ email_id: "e1", folder_id: null, classified_by: "ai" }),
      );
    } else {
      expect(classifyEmailsBatch).not.toHaveBeenCalled();
      expect(classifyEmail).not.toHaveBeenCalled();
      expect(updateEmailEncrypted).toHaveBeenCalledWith(
        expect.objectContaining({
          email_id: "e1",
          folder_id: oracle.folder_id,
          classified_by: oracle.classified_by,
        }),
      );
    }
  });
});

describe("path 5 — rescue's separate AI confidence gate (audit §2 bullet 3)", () => {
  it("the per-message AI fallback files BELOW min_ai_confidence — pinned", async () => {
    // rescue's batch lane applies the folder's min_ai_confidence exactly
    // like classifyByAi (rescue.ts:300-313, covered in rescue.test.ts) —
    // but its per-message fallback (rescue.ts:266-281, used when the batch
    // throws or omits an index) applies NO gate at all.
    const s: FolderScenario = {
      name: "gated AI folder, no rules",
      email: { from_addr: "stranger@nowhere.test" },
      folders: [
        makeFolder({
          id: "f-gated",
          name: "Gated",
          ai_rule: "interesting mail",
          min_ai_confidence: 0.9,
        }),
      ],
      filters: [],
      expect: { folder_id: null, needs_ai: true },
    };
    expect(oracleDecision(s)).toMatchObject(s.expect); // scenario sanity

    seedStrandedScenario(s);
    classifyEmailsBatch.mockRejectedValueOnce(new Error("batch gateway down"));
    classifyEmail.mockResolvedValueOnce({
      folder_id: "f-gated",
      confidence: 0.2,
      summary: "s",
      reason: "maybe",
    });

    const res = await rescueStrandedEmails();
    expect(res).toMatchObject({ scanned: 1, rescued: 1, failed: 0, skipped: 0 });

    // DIVERGENCE (audit §2 bullet 3 "AI confidence gate is implemented
    // twice with different behaviour"; §6.5 wants ONE gate): the live
    // path (classify.ts:134-146) and rescue's own batch lane would stamp
    // ai_low_confidence with folder_id null for 0.2 < min 0.9 — the
    // fallback lane persists the folder as classified_by "ai" anyway.
    // (The fallback also offers ctx.enrichedFolders UNFILTERED by
    // aiCandidateIds, unlike classifyByAi.) If this pin fails with
    // folder_id null / ai_low_confidence, the gates were unified — delete
    // this divergence.
    expect(updateEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({
        email_id: "e1",
        folder_id: "f-gated",
        classified_by: "ai",
        ai_confidence: 0.2,
      }),
    );
  });
});
