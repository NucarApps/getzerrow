// Tests for the cron-driven contact-enrichment queue
// (src/lib/contacts/enrich-jobs.server.ts).
//
// Two passes run here, both under the admin (service-role) client, which
// means RLS is NOT scoping anything: every read and write has to carry the
// job's own user_id explicitly. The highest-value contracts are therefore
//   * a claim RPC failure aborts before any provider work happens,
//   * every provider call is made with the CLAIMED JOB's user_id — never a
//     leftover from the previous job in the batch,
//   * one provider throwing fails only its own job; the rest still finish,
//   * enqueue is idempotent (a live job for a contact is not re-queued, and
//     a duplicate whole-user scan reports alreadyQueued instead of throwing).
//
// The AI providers are all lazily imported inside the worker, so each is
// mocked as a module here and asserted on directly.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeSupabaseFake,
  mockSupabaseAdmin,
  writeCount,
  type RecordedWrite,
} from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake({ applyWrites: true });

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));
vi.mock("@/lib/log.server", () => ({ logInfo: vi.fn(), logError: vi.fn() }));

const providers = vi.hoisted(() => ({
  runEnrichForContact: vi.fn<typeof import("./enrich.functions").runEnrichForContact>(),
  runContactGroupSuggestionsImpl:
    vi.fn<typeof import("./suggest-groups.functions").runContactGroupSuggestionsImpl>(),
  applySuggestionImpl: vi.fn<typeof import("./suggest-groups.functions").applySuggestionImpl>(),
  scanContactDuplicatesImpl: vi.fn<typeof import("./dedup.functions").scanContactDuplicatesImpl>(),
  scanContactEnrichmentImpl:
    vi.fn<typeof import("./enrich-suggest.functions").scanContactEnrichmentImpl>(),
  syncCompanyRuleMemberships:
    vi.fn<typeof import("./group-rules.functions").syncCompanyRuleMemberships>(),
}));

vi.mock("./enrich.functions", () => ({
  runEnrichForContact: providers.runEnrichForContact,
}));
vi.mock("./suggest-groups.functions", () => ({
  runContactGroupSuggestionsImpl: providers.runContactGroupSuggestionsImpl,
  applySuggestionImpl: providers.applySuggestionImpl,
}));
vi.mock("./dedup.functions", () => ({
  scanContactDuplicatesImpl: providers.scanContactDuplicatesImpl,
}));
vi.mock("./enrich-suggest.functions", () => ({
  scanContactEnrichmentImpl: providers.scanContactEnrichmentImpl,
}));
vi.mock("./group-rules.functions", () => ({
  syncCompanyRuleMemberships: providers.syncCompanyRuleMemberships,
}));

import {
  enqueueContactEnrichment,
  enqueueUserScanJob,
  processContactEnrichJobs,
} from "./enrich-jobs.server";

const CLAIM_RPC = "claim_contact_enrich_jobs";
const NOW = new Date("2026-09-02T12:00:00.000Z");

type ClaimedJob = {
  id: string;
  user_id: string;
  kind: "bio" | "suggest" | "dedup_scan" | "signature_scan";
  contact_id: string | null;
};

/** Make the claim RPC hand the worker exactly these jobs. */
function claims(jobs: ClaimedJob[]) {
  fake.onRpc(CLAIM_RPC, () => ({ data: jobs }));
}

function jobWrites(kind: "inserts" | "updates"): RecordedWrite[] {
  return fake.calls[kind].filter((w) => w.table === "contact_enrich_jobs");
}

/** `{ jobId: status }` for every finish() the worker wrote. */
function finishedStatuses(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const u of jobWrites("updates")) {
    const id = u.filters.find((f) => f.op === "eq" && f.col === "id")?.value;
    out[String(id)] = (u.payload as { status?: unknown }).status;
  }
  return out;
}

beforeEach(() => {
  fake.reset();
  for (const fn of Object.values(providers)) fn.mockReset();
  // The worker ignores every provider's return value except this one, whose
  // group_id decides whether a durable rule is written.
  providers.applySuggestionImpl.mockResolvedValue({ ok: true, group_id: "group-1", added: 1 });
});

/* -------------------------------------------------------------------------- */
/* processContactEnrichJobs — claiming                                         */
/* -------------------------------------------------------------------------- */

describe("processContactEnrichJobs — claiming", () => {
  it("throws and runs no provider when the claim RPC fails", async () => {
    fake.onRpc(CLAIM_RPC, () => ({ error: { message: "lock wait timeout" } }));

    await expect(processContactEnrichJobs(5)).rejects.toThrow("lock wait timeout");

    expect(providers.runEnrichForContact).not.toHaveBeenCalled();
    expect(providers.scanContactDuplicatesImpl).not.toHaveBeenCalled();
    // Nothing was marked done or failed: the batch never started.
    expect(writeCount(fake)).toBe(0);
  });

  it("asks for the caller's limit and reports an empty batch when nothing is claimable", async () => {
    claims([]);

    const res = await processContactEnrichJobs(7);

    expect(res).toStrictEqual({ processed: 0, succeeded: 0, failed: 0, autoApplied: 0 });
    expect(fake.calls.rpcs).toStrictEqual([{ fn: CLAIM_RPC, args: { p_limit: 7 } }]);
    expect(writeCount(fake)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* processContactEnrichJobs — per-job user scoping                             */
/* -------------------------------------------------------------------------- */

describe("processContactEnrichJobs — user scoping", () => {
  it("runs every provider under the claimed job's own user_id, never the previous job's", async () => {
    claims([
      { id: "job-1", user_id: "user-a", kind: "bio", contact_id: "contact-a" },
      { id: "job-2", user_id: "user-b", kind: "bio", contact_id: "contact-b" },
      { id: "job-3", user_id: "user-c", kind: "dedup_scan", contact_id: null },
      { id: "job-4", user_id: "user-d", kind: "signature_scan", contact_id: null },
    ]);

    const res = await processContactEnrichJobs(10);

    expect(res).toStrictEqual({ processed: 4, succeeded: 4, failed: 0, autoApplied: 0 });
    expect(
      providers.runEnrichForContact.mock.calls.map(([ctx, contactId, force]) => [
        ctx.userId,
        contactId,
        force,
      ]),
    ).toStrictEqual([
      ["user-a", "contact-a", false],
      ["user-b", "contact-b", false],
    ]);
    expect(providers.scanContactDuplicatesImpl.mock.calls).toStrictEqual([["user-c"]]);
    expect(
      providers.scanContactEnrichmentImpl.mock.calls.map(([, userId]) => userId),
    ).toStrictEqual(["user-d"]);
  });

  it("skips a bio job that carries no contact_id but still marks it done", async () => {
    claims([{ id: "job-1", user_id: "user-a", kind: "bio", contact_id: null }]);

    const res = await processContactEnrichJobs(1);

    expect(res).toStrictEqual({ processed: 1, succeeded: 1, failed: 0, autoApplied: 0 });
    expect(providers.runEnrichForContact).not.toHaveBeenCalled();
    expect(finishedStatuses()).toStrictEqual({ "job-1": "done" });
  });
});

/* -------------------------------------------------------------------------- */
/* processContactEnrichJobs — isolation of a failing job                       */
/* -------------------------------------------------------------------------- */

describe("processContactEnrichJobs — one job failing", () => {
  it("marks only the throwing job failed and still finishes the rest of the batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    claims([
      { id: "job-1", user_id: "user-a", kind: "bio", contact_id: "contact-a" },
      { id: "job-2", user_id: "user-b", kind: "bio", contact_id: "contact-b" },
      { id: "job-3", user_id: "user-c", kind: "dedup_scan", contact_id: null },
    ]);
    providers.runEnrichForContact.mockRejectedValueOnce(new Error("model provider is down"));

    const res = await processContactEnrichJobs(10);

    expect(res).toStrictEqual({ processed: 3, succeeded: 2, failed: 1, autoApplied: 0 });
    expect(finishedStatuses()).toStrictEqual({
      "job-1": "failed",
      "job-2": "done",
      "job-3": "done",
    });
    const failure = jobWrites("updates")[0]!;
    expect(failure.payload).toStrictEqual({
      status: "failed",
      error: "model provider is down",
      finished_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    // A successful finish clears the error column rather than leaving a
    // stale message from an earlier attempt.
    expect(jobWrites("updates")[1]!.payload).toStrictEqual({
      status: "done",
      error: null,
      finished_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
  });

  it("truncates a runaway provider error to 500 characters", async () => {
    claims([{ id: "job-1", user_id: "user-a", kind: "bio", contact_id: "contact-a" }]);
    providers.runEnrichForContact.mockRejectedValue(new Error("x".repeat(900)));

    await processContactEnrichJobs(1);

    const payload = jobWrites("updates")[0]!.payload as { error: string };
    expect(payload.error).toBe("x".repeat(500));
  });

  it("treats the suggest rescan cooldown as success and still runs the auto-apply gate", async () => {
    claims([{ id: "job-1", user_id: "user-a", kind: "suggest", contact_id: null }]);
    providers.runContactGroupSuggestionsImpl.mockRejectedValue(
      new Error("Scan already ran — wait 120s"),
    );

    const res = await processContactEnrichJobs(1);

    expect(res).toStrictEqual({ processed: 1, succeeded: 1, failed: 0, autoApplied: 0 });
    expect(finishedStatuses()).toStrictEqual({ "job-1": "done" });
  });

  it("fails a suggest job when the scan throws anything other than the cooldown", async () => {
    claims([{ id: "job-1", user_id: "user-a", kind: "suggest", contact_id: null }]);
    providers.runContactGroupSuggestionsImpl.mockRejectedValue(new Error("gateway 502"));

    const res = await processContactEnrichJobs(1);

    expect(res).toStrictEqual({ processed: 1, succeeded: 0, failed: 1, autoApplied: 0 });
    expect(finishedStatuses()).toStrictEqual({ "job-1": "failed" });
  });
});

/* -------------------------------------------------------------------------- */
/* processContactEnrichJobs — the auto-apply gate on a suggest job             */
/* -------------------------------------------------------------------------- */

describe("processContactEnrichJobs — auto-apply gate", () => {
  const USER = "gate-user";
  const CONTACTS = ["contact-1", "contact-2"];

  function seedDomainBackedSuggestion(email: (id: string) => string) {
    fake.seed("contact_group_suggestions", [
      {
        id: "suggestion-1",
        user_id: USER,
        name: "Acme",
        kind: "company",
        contact_ids: CONTACTS,
        existing_group_id: null,
        confidence: "high",
        status: "pending",
        created_at: "2026-09-01T00:00:00.000Z",
      },
    ]);
    fake.seed(
      "contacts",
      CONTACTS.map((id) => ({ id, user_id: USER, email: email(id), company_id: null })),
    );
    fake.seed("company_domains", [
      { user_id: USER, domain: "acme.test", company_id: "company-acme" },
    ]);
    fake.seed("companies", [
      {
        id: "company-other",
        user_id: USER,
        name: "Other",
        name_key: null,
        linked_group_id: null,
      },
    ]);
  }

  it("auto-applies a domain-backed suggestion and writes a durable domain rule", async () => {
    seedDomainBackedSuggestion((id) => `${id}@acme.test`);
    claims([{ id: "job-1", user_id: USER, kind: "suggest", contact_id: null }]);

    const res = await processContactEnrichJobs(1);

    expect(res).toStrictEqual({ processed: 1, succeeded: 1, failed: 0, autoApplied: 1 });
    expect(
      providers.applySuggestionImpl.mock.calls.map(([, userId, args]) => [userId, args]),
    ).toStrictEqual([
      [
        USER,
        {
          id: "suggestion-1",
          autoApplied: true,
          evidence: {
            reason: "domain_backed",
            domain: "acme.test",
            company: "company-acme",
            members: 2,
          },
        },
      ],
    ]);
    const rule = fake.calls.upserts.find((u) => u.table === "contact_group_rules");
    expect(rule?.payload).toStrictEqual({
      user_id: USER,
      group_id: "group-1",
      rule_type: "domain",
      value: "acme.test",
      auto_apply: true,
    });
    // A domain rule needs no company-membership resync.
    expect(providers.syncCompanyRuleMemberships).not.toHaveBeenCalled();
  });

  it("reads the member domain the same way the rest of the app does, angle brackets included", async () => {
    // contacts.email can hold a raw From header when the row was created
    // from mail rather than typed in. A private lastIndexOf("@") reader
    // yields "acme.test>" for it, which matches no company_domains row and
    // silently blocks the auto-apply; emailDomain() is the shared parser.
    seedDomainBackedSuggestion((id) => `Person ${id} <${id}@acme.test>`);
    claims([{ id: "job-1", user_id: USER, kind: "suggest", contact_id: null }]);

    const res = await processContactEnrichJobs(1);

    expect(res.autoApplied).toBe(1);
    expect(providers.applySuggestionImpl).toHaveBeenCalledTimes(1);
  });

  it("syncs company memberships when the durable rule is a company_id rule", async () => {
    fake.seed("contact_group_suggestions", [
      {
        id: "suggestion-1",
        user_id: USER,
        name: "Acme",
        kind: "company",
        contact_ids: CONTACTS,
        existing_group_id: "group-acme",
        confidence: "high",
        status: "pending",
        created_at: "2026-09-01T00:00:00.000Z",
      },
    ]);
    fake.seed(
      "contacts",
      CONTACTS.map((id) => ({
        id,
        user_id: USER,
        email: `${id}@acme.test`,
        company_id: "company-acme",
      })),
    );
    fake.seed("companies", [
      {
        id: "company-acme",
        user_id: USER,
        name: "Acme",
        name_key: null,
        linked_group_id: "group-acme",
      },
    ]);
    claims([{ id: "job-1", user_id: USER, kind: "suggest", contact_id: null }]);

    const res = await processContactEnrichJobs(1);

    expect(res.autoApplied).toBe(1);
    expect(
      fake.calls.upserts.find((u) => u.table === "contact_group_rules")?.payload,
    ).toStrictEqual({
      user_id: USER,
      group_id: "group-1",
      rule_type: "company_id",
      value: "company-acme",
      auto_apply: true,
    });
    expect(
      providers.syncCompanyRuleMemberships.mock.calls.map(([, userId, opts]) => [userId, opts]),
    ).toStrictEqual([[USER, { companyIds: ["company-acme"], bumpResync: true }]]);
  });

  it("leaves a suggestion pending when the deterministic evidence does not back it", async () => {
    // Two different non-personal domains: no dominant company, no single
    // domain — the AI's own "high" confidence is not enough on its own.
    seedDomainBackedSuggestion((id) => `${id}@${id}.test`);
    claims([{ id: "job-1", user_id: USER, kind: "suggest", contact_id: null }]);

    const res = await processContactEnrichJobs(1);

    expect(res).toStrictEqual({ processed: 1, succeeded: 1, failed: 0, autoApplied: 0 });
    expect(providers.applySuggestionImpl).not.toHaveBeenCalled();
    expect(fake.calls.upserts).toStrictEqual([]);
  });

  it("keeps the job successful when applying one suggestion throws", async () => {
    seedDomainBackedSuggestion((id) => `${id}@acme.test`);
    claims([{ id: "job-1", user_id: USER, kind: "suggest", contact_id: null }]);
    providers.applySuggestionImpl.mockRejectedValue(new Error("group was deleted"));

    const res = await processContactEnrichJobs(1);

    expect(res).toStrictEqual({ processed: 1, succeeded: 1, failed: 0, autoApplied: 0 });
    expect(finishedStatuses()).toStrictEqual({ "job-1": "done" });
  });
});

/* -------------------------------------------------------------------------- */
/* enqueueUserScanJob                                                          */
/* -------------------------------------------------------------------------- */

describe("enqueueUserScanJob", () => {
  it("queues a pending whole-user scan row", async () => {
    const res = await enqueueUserScanJob("user-a", "dedup_scan");

    expect(res).toStrictEqual({ queued: true, alreadyQueued: false });
    expect(jobWrites("inserts").map((i) => i.payload)).toStrictEqual([
      { user_id: "user-a", kind: "dedup_scan", contact_id: null, status: "pending" },
    ]);
  });

  it("reports alreadyQueued instead of throwing when the live-job unique index rejects a duplicate", async () => {
    fake.onInsert("contact_enrich_jobs", () => ({
      message: "duplicate key value violates unique constraint",
      code: "23505",
    }));

    const res = await enqueueUserScanJob("user-a", "signature_scan");

    expect(res).toStrictEqual({ queued: false, alreadyQueued: true });
  });

  it("propagates any other insert failure", async () => {
    fake.onInsert("contact_enrich_jobs", () => ({ message: "permission denied", code: "42501" }));

    await expect(enqueueUserScanJob("user-a", "dedup_scan")).rejects.toThrow("permission denied");
  });
});

/* -------------------------------------------------------------------------- */
/* enqueueContactEnrichment                                                    */
/* -------------------------------------------------------------------------- */

describe("enqueueContactEnrichment", () => {
  const USER = "enqueue-user";

  function seedUserWithContacts(count: number) {
    fake.seed("gmail_accounts", [{ user_id: USER }]);
    fake.seed(
      "contacts",
      Array.from({ length: count }, (_, i) => ({
        id: `contact-${i}`,
        user_id: USER,
        email: `person-${i}@acme.test`,
        summary_generated_at: null,
        enriched_at: null,
      })),
    );
  }

  it("queues one bio job per candidate contact, scoped to that contact's user", async () => {
    seedUserWithContacts(2);

    const res = await enqueueContactEnrichment();

    expect(res).toStrictEqual({ users: 1, bioJobs: 2, suggestJobs: 0 });
    expect(jobWrites("inserts").map((i) => i.payload)).toStrictEqual([
      [
        { user_id: USER, kind: "bio", contact_id: "contact-0" },
        { user_id: USER, kind: "bio", contact_id: "contact-1" },
      ],
    ]);
  });

  it("does not queue a second bio job for a contact that already has a live one", async () => {
    seedUserWithContacts(2);
    fake.seed("contact_enrich_jobs", [
      { id: "live-1", user_id: USER, kind: "bio", contact_id: "contact-0", status: "pending" },
      { id: "live-2", user_id: USER, kind: "bio", contact_id: "contact-1", status: "running" },
    ]);

    const res = await enqueueContactEnrichment();

    expect(res).toStrictEqual({ users: 1, bioJobs: 0, suggestJobs: 0 });
    expect(jobWrites("inserts")).toStrictEqual([]);
  });

  it("ignores a finished job for the same contact — only pending/running jobs dedupe", async () => {
    seedUserWithContacts(1);
    fake.seed("contact_enrich_jobs", [
      {
        id: "old-1",
        user_id: USER,
        kind: "bio",
        contact_id: "contact-0",
        status: "done",
        finished_at: "2020-01-01T00:00:00.000Z",
      },
    ]);

    const res = await enqueueContactEnrichment();

    expect(res).toStrictEqual({ users: 1, bioJobs: 1, suggestJobs: 0 });
  });

  it("never queues another user's contact under this user's id", async () => {
    seedUserWithContacts(1);
    fake.seed("contacts", [
      {
        id: "contact-mine",
        user_id: USER,
        email: "mine@acme.test",
        summary_generated_at: null,
        enriched_at: null,
      },
      {
        id: "contact-theirs",
        user_id: "someone-else",
        email: "theirs@acme.test",
        summary_generated_at: null,
        enriched_at: null,
      },
    ]);

    const res = await enqueueContactEnrichment();

    expect(res.bioJobs).toBe(1);
    expect(jobWrites("inserts").map((i) => i.payload)).toStrictEqual([
      [{ user_id: USER, kind: "bio", contact_id: "contact-mine" }],
    ]);
  });

  it("queues a daily suggest scan once the user has enough contacts", async () => {
    seedUserWithContacts(5);

    const res = await enqueueContactEnrichment();

    expect(res).toStrictEqual({ users: 1, bioJobs: 5, suggestJobs: 1 });
    expect(jobWrites("inserts").at(-1)?.payload).toStrictEqual({ user_id: USER, kind: "suggest" });
  });

  it("does not queue a second suggest scan inside the 24h interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    seedUserWithContacts(5);
    fake.seed("contact_enrich_jobs", [
      {
        id: "recent-suggest",
        user_id: USER,
        kind: "suggest",
        contact_id: null,
        status: "done",
        finished_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      },
    ]);

    const res = await enqueueContactEnrichment();

    expect(res.suggestJobs).toBe(0);
    // Only the bio batch was written — no second suggest row.
    expect(jobWrites("inserts").map((i) => i.payload)).toStrictEqual([
      Array.from({ length: 5 }, (_, i) => ({
        user_id: USER,
        kind: "bio",
        contact_id: `contact-${i}`,
      })),
    ]);
  });

  it("keeps going when one user's pass throws, and reports the users it walked", async () => {
    fake.seed("gmail_accounts", [{ user_id: "user-a" }, { user_id: "user-b" }]);
    fake.seed("contacts", [
      {
        id: "contact-b",
        user_id: "user-b",
        email: "b@acme.test",
        summary_generated_at: null,
        enriched_at: null,
      },
    ]);
    let firstSelect = true;
    fake.onSelect("contacts", () => {
      if (firstSelect) {
        firstSelect = false;
        throw new Error("statement timeout");
      }
      return undefined;
    });

    const res = await enqueueContactEnrichment();

    expect(res).toStrictEqual({ users: 2, bioJobs: 1, suggestJobs: 0 });
    expect(jobWrites("inserts").map((i) => i.payload)).toStrictEqual([
      [{ user_id: "user-b", kind: "bio", contact_id: "contact-b" }],
    ]);
  });

  it("throws when the account listing itself fails, before touching any user", async () => {
    fake.onSelect("gmail_accounts", () => ({ message: "connection reset" }));

    await expect(enqueueContactEnrichment()).rejects.toThrow("connection reset");
    expect(writeCount(fake)).toBe(0);
  });
});
