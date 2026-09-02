// buildCatchupRow turns one fetched+parsed Gmail message into the
// INSERT shape used by the bulk-catchup path. Critical contract:
// - Rules-matched mail carries final folder_id + flags (auto_archive
//   etc. baked into is_archived) so the single INSERT lands the row
//   in its destination list with no flicker.
// - AI-needed mail carries classified_by='pending_ai' and folder_id
//   null so it lands in the Inbox while the AI lane finishes.
// - Excluded-label messages (SENT/DRAFT/TRASH/SPAM/CHAT) are dropped.
// - Inbox-override (allowlist) stays terminal — AI must NOT route a
//   pinned sender into a folder.
//
// bulkCatchupClaim (the second describe below) is the queue side: it claims
// across ALL accounts, so anything it does not own has to be released, and
// every failure mode has to leave the job in a state the cron lane can pick
// up again.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "../__fixtures__/supabase-fake";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const getMessage = vi.fn(async (_acc: string, _id: string) => ({ id: "m" }));
const parseMessage = vi.fn((_raw: unknown) => parsedStub());
vi.mock("../gmail.server", () => ({
  getMessage: (a: string, b: string) => getMessage(a, b),
  parseMessage: (raw: unknown) => parseMessage(raw),
}));

const loadAccountContext = vi.fn(async (_a: string, _u: string) => ctx());
vi.mock("./account-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./account-context")>()),
  loadAccountContext: (a: string, u: string) => loadAccountContext(a, u),
}));

const upsertEmailEncrypted = vi.fn(async (_i: unknown) => ({
  id: "email-1" as string | null,
  error: null as string | null,
}));
const updateEmailEncrypted = vi.fn(async (_i: unknown) => ({ error: null as string | null }));
vi.mock("./encrypted-writer", () => ({
  upsertEmailEncrypted: (i: unknown) => upsertEmailEncrypted(i),
  updateEmailEncrypted: (i: unknown) => updateEmailEncrypted(i),
}));

vi.mock("./folder-learn", () => ({ bumpEmailsSinceLearn: vi.fn() }));
vi.mock("./process-message", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./process-message")>()),
  applyFolderActions: vi.fn(async () => {}),
}));
vi.mock("../log.server", () => ({ logError: vi.fn(), logInfo: vi.fn() }));

import { buildCatchupRow, bulkCatchupClaim } from "./catchup";
import type { AccountContext } from "./account-context";
import { makeEmailRow, makeFolder, makeRule } from "../__fixtures__/email-row";

const folder = makeFolder;
const filter = makeRule;

function ctx(over: Partial<AccountContext> = {}): AccountContext {
  return {
    folders: over.folders ?? [],
    filters: over.filters ?? [],
    overrides: over.overrides ?? [],
    overrideExceptions: over.overrideExceptions ?? [],
    enrichedFolders: over.enrichedFolders ?? [],
    calendarGuardEnabled: over.calendarGuardEnabled ?? false,
    calendarContacts: over.calendarContacts ?? new Set<string>(),
    accountEmail: over.accountEmail ?? null,
    senderGroups: over.senderGroups ?? new Map(),
  };
}

function parsed(
  over: Partial<ReturnType<typeof import("../gmail.server").parseMessage>> = {},
): ReturnType<typeof import("../gmail.server").parseMessage> {
  return {
    ...makeEmailRow(over),
    cc: over.cc ?? "",
    list_id: over.list_id ?? "",
    in_reply_to: over.in_reply_to ?? "",
    raw_labels: over.raw_labels ?? ["INBOX"],
    gmail_message_id: over.gmail_message_id ?? "g-1",
    thread_id: over.thread_id ?? "t-1",
    reply_to_addr: over.reply_to_addr ?? null,
    origin_addr: over.origin_addr ?? null,
    origin_name: over.origin_name ?? null,
    is_forwarded: over.is_forwarded ?? false,
    has_calendar_invite: over.has_calendar_invite ?? false,
    is_read: over.is_read ?? false,
  };
}

const job = {
  id: "job-1",
  gmail_account_id: "acc-1",
  gmail_message_id: "g-1",
  user_id: "user-1",
  attempt: 0,
  priority: 0,
  published_at_ms: null,
};

describe("buildCatchupRow", () => {
  it("drops messages with excluded labels (SENT/DRAFT/TRASH/SPAM/CHAT)", () => {
    const c = ctx();
    for (const label of ["SENT", "DRAFT", "TRASH", "SPAM", "CHAT"]) {
      expect(buildCatchupRow(job, parsed({ raw_labels: [label] }), c)).toBeNull();
    }
  });

  it("rule-matched mail: row carries final folder_id, no pending_ai", () => {
    const f = folder({ id: "f1", name: "Work" });
    const c = ctx({
      folders: [f],
      filters: [filter("f1", "from", "contains", "@acme.com")],
      enrichedFolders: [{ id: "f1", name: "Work", ai_rule: "route mail here" }],
    });
    const built = buildCatchupRow(job, parsed({ from_addr: "billing@acme.com" }), c);
    expect(built).not.toBeNull();
    expect(built!.needs_ai).toBe(false);
    expect(built!.folder_id).toBe("f1");
    expect(built!.upsert.classified_by).toBe("filter");
    expect(built!.update!.folder_id).toBe("f1");
  });

  it("rule-matched mail with auto_archive: is_archived true in INSERT (no flicker)", () => {
    const f = folder({ id: "f1", name: "Newsletters", auto_archive: true });
    const c = ctx({
      folders: [f],
      filters: [filter("f1", "from", "contains", "@news.test")],
      enrichedFolders: [{ id: "f1", name: "Newsletters", ai_rule: "route mail here" }],
    });
    const built = buildCatchupRow(
      job,
      parsed({ from_addr: "a@news.test", raw_labels: ["INBOX"] }),
      c,
    );
    expect(built!.upsert.is_archived).toBe(true);
    expect(built!.update!.folder_id).toBe("f1");
  });

  it("rule-matched mail with auto_mark_read: is_read true in INSERT", () => {
    const f = folder({ id: "f1", name: "Promo", auto_mark_read: true });
    const c = ctx({
      folders: [f],
      filters: [filter("f1", "subject", "contains", "sale")],
      enrichedFolders: [{ id: "f1", name: "Promo", ai_rule: "route mail here" }],
    });
    const built = buildCatchupRow(job, parsed({ subject: "Big sale", is_read: false }), c);
    expect(built!.upsert.is_read).toBe(true);
  });

  it("no rule matches + AI candidates exist: row is pending_ai, folder null", () => {
    const f = folder({ id: "f1", name: "Work" });
    const c = ctx({
      folders: [f],
      enrichedFolders: [{ id: "f1", name: "Work", ai_rule: "route mail here" }],
    });
    const built = buildCatchupRow(job, parsed({ from_addr: "nobody@nowhere.test" }), c);
    expect(built!.needs_ai).toBe(true);
    expect(built!.folder_id).toBeNull();
    expect(built!.upsert.classified_by).toBe("pending_ai");
  });

  it("inbox_override (allowlist) stays terminal — AI must NOT route into a folder", () => {
    const f = folder({ id: "f1", name: "Work" });
    const c = ctx({
      folders: [f],
      overrides: [{ id: "o1", match_type: "domain", value: "vip.example" }],
      enrichedFolders: [{ id: "f1", name: "Work", ai_rule: "route mail here" }],
    });
    const built = buildCatchupRow(job, parsed({ from_addr: "ceo@vip.example" }), c);
    expect(built!.needs_ai).toBe(false);
    expect(built!.upsert.classified_by).toBe("inbox_override");
    expect(built!.folder_id).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* bulkCatchupClaim — queue handling                                           */
/* -------------------------------------------------------------------------- */

const ACC = "acc-1";
const USER = "user-1";

function parsedStub(over: Record<string, unknown> = {}) {
  return {
    gmail_message_id: "gm-1",
    thread_id: "t-1",
    from_addr: "a@x.com",
    from_name: "A",
    to_addrs: "me@x.com",
    subject: "hi",
    snippet: "s",
    body_text: "b",
    body_html: null,
    received_at: "2026-09-01T00:00:00Z",
    is_read: false,
    has_attachment: false,
    raw_labels: ["INBOX"],
    ...over,
  };
}

type Job = {
  id: string;
  gmail_account_id: string;
  gmail_message_id: string;
  user_id: string;
  attempt: number;
  priority: number;
  published_at_ms: number | null;
};

function queueJob(over: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    gmail_account_id: ACC,
    gmail_message_id: "gm-1",
    user_id: USER,
    attempt: 0,
    priority: 0,
    published_at_ms: null,
    ...over,
  };
}

function jobUpdates() {
  return fake.calls.updates.filter((u) => u.table === "message_jobs");
}
function jobDeletes() {
  return fake.calls.deletes.filter((d) => d.table === "message_jobs");
}
/** ids named by an `in("id", [...])` filter on a recorded write. */
function idsOf(w: { filters: Array<{ op: string; col?: string; value?: unknown }> }): string[] {
  return (w.filters.find((f) => f.op === "in" && f.col === "id")?.value as string[]) ?? [];
}

describe("bulkCatchupClaim", () => {
  beforeEach(() => {
    fake.reset();
    fake.seed("message_jobs", []);
    loadAccountContext.mockResolvedValue(ctx());
    getMessage.mockResolvedValue({ id: "m" });
    parseMessage.mockReturnValue(parsedStub());
    upsertEmailEncrypted.mockResolvedValue({ id: "email-1", error: null });
    updateEmailEncrypted.mockResolvedValue({ error: null });
  });

  it("releases jobs the RPC claimed for OTHER accounts instead of leaving them locked", async () => {
    // claim_message_jobs claims across all accounts; the ones this caller
    // does not own were previously dropped on the floor, still locked,
    // stalling the other mailbox until the 35s stuck-job reclaim.
    const mine = queueJob({ id: "mine" });
    const otherAccount = queueJob({ id: "other-acc", gmail_account_id: "acc-2" });
    const otherUser = queueJob({ id: "other-user", user_id: "user-2" });
    fake.onRpc("claim_message_jobs", () => [mine, otherAccount, otherUser]);

    await bulkCatchupClaim(ACC, USER);

    const released = jobUpdates().filter((u) => idsOf(u).includes("other-acc"));
    expect(released).toHaveLength(1);
    expect(idsOf(released[0]!)).toEqual(["other-acc", "other-user"]);
    expect(released[0]!.payload).toEqual({ status: "pending", locked_at: null });
  });

  it("releases every claimed job when the account context cannot be loaded", async () => {
    fake.onRpc("claim_message_jobs", () => [queueJob({ id: "j1" }), queueJob({ id: "j2" })]);
    loadAccountContext.mockRejectedValueOnce(new Error("db down"));
    const res = await bulkCatchupClaim(ACC, USER);
    expect(res).toMatchObject({ scanned: 2, inserted: 0 });
    expect(getMessage).not.toHaveBeenCalled();
    expect(idsOf(jobUpdates()[0]!)).toEqual(["j1", "j2"]);
  });

  it("drops a job whose message is gone (404) but requeues other fetch errors after 30s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00Z"));
    try {
      fake.onRpc("claim_message_jobs", () => [
        queueJob({ id: "gone", gmail_message_id: "gm-gone" }),
        queueJob({ id: "flaky", gmail_message_id: "gm-flaky" }),
      ]);
      getMessage.mockImplementation(async (_a: string, id: string) => {
        throw new Error(id === "gm-gone" ? "Gmail API 404 not found" : "Gmail API 503 unavailable");
      });
      const res = await bulkCatchupClaim(ACC, USER);
      expect(res).toMatchObject({ scanned: 2, inserted: 0, fetch_failed: 2 });
      expect(idsOf(jobDeletes()[0]!)).toEqual(["gone"]);
      const released = jobUpdates().find((u) => idsOf(u).includes("flaky"))!;
      expect(released.payload).toEqual({
        status: "pending",
        locked_at: null,
        next_run_at: new Date("2026-09-01T12:00:30Z").toISOString(),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets an AI-needed job to pending and deletes a rules-final one", async () => {
    const F = makeFolder({ id: "f-1", name: "News" });
    loadAccountContext.mockResolvedValue(
      ctx({
        folders: [F],
        filters: [makeRule("f-1", "from", "contains", "a@x.com")],
        enrichedFolders: [{ id: "f-1", name: "News", ai_rule: null }],
      }),
    );
    fake.onRpc("claim_message_jobs", () => [
      queueJob({ id: "rules", gmail_message_id: "gm-rules" }),
      queueJob({ id: "ai", gmail_message_id: "gm-ai" }),
    ]);
    parseMessage.mockImplementation((raw: unknown) =>
      parsedStub({
        gmail_message_id: (raw as { id: string }).id,
        from_addr: (raw as { id: string }).id === "gm-rules" ? "a@x.com" : "z@other.com",
      }),
    );
    getMessage.mockImplementation(async (_a: string, id: string) => ({ id }));

    const res = await bulkCatchupClaim(ACC, USER);
    expect(res).toMatchObject({ scanned: 2, inserted: 2, ai_pending: 1 });
    expect(idsOf(jobDeletes()[0]!)).toEqual(["rules"]);
    const reset = jobUpdates().find((u) => idsOf(u).includes("ai"))!;
    expect(reset.payload).toMatchObject({ status: "pending", locked_at: null });
  });

  // CHARACTERIZATION(catchup-upsert-error-drops-message): when the encrypted
  // upsert fails the row is never written, yet the job is still deleted as
  // "rules matched" — the message is lost until a reconcile re-ingests it.
  it("deletes the job even when the row upsert failed (message lost until reconcile)", async () => {
    fake.onRpc("claim_message_jobs", () => [queueJob({ id: "j1" })]);
    upsertEmailEncrypted.mockResolvedValue({ id: null, error: "encrypt failed" });
    const res = await bulkCatchupClaim(ACC, USER);
    expect(res.inserted).toBe(0);
    expect(idsOf(jobDeletes()[0]!)).toEqual(["j1"]);
  });

  it("reports overflow when live jobs remain pending for the account", async () => {
    fake.onRpc("claim_message_jobs", () => [queueJob({ id: "j1" })]);
    fake.seed("message_jobs", [
      { id: "left-1", gmail_account_id: ACC, status: "pending", priority: 0 },
      { id: "other", gmail_account_id: "acc-2", status: "pending", priority: 0 },
      { id: "backfill", gmail_account_id: ACC, status: "pending", priority: 10 },
    ]);
    const res = await bulkCatchupClaim(ACC, USER);
    expect(res.overflowed).toBe(true);
  });

  it("returns a zero result and touches nothing when the claim RPC errors", async () => {
    fake.onRpc("claim_message_jobs", () => ({ error: { message: "rpc down" } }));
    const res = await bulkCatchupClaim(ACC, USER);
    expect(res).toEqual({
      scanned: 0,
      inserted: 0,
      ai_pending: 0,
      fetch_failed: 0,
      overflowed: false,
    });
    expect(jobUpdates()).toHaveLength(0);
    expect(jobDeletes()).toHaveLength(0);
  });
});
