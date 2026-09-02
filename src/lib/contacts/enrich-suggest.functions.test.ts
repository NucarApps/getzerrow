// Contact enrichment suggestions (enrich-suggest.functions.ts). Contracts
// protected:
//
//   * applyContactEnrichmentSuggestion writes BOTH sides — the field patch
//     on contacts (or the encrypted writer for a phone) AND the status
//     bookkeeping on the suggestion row — and dismisses the competing
//     pending suggestions for the same field,
//   * a suggestion that is not pending is a no-op (idempotent double-click),
//   * dismiss/undismiss pin their exact update payload and filters,
//   * the scan makes NO model call when there are no candidates, and its
//     domain fallback only fires for a routable, non-personal domain when
//     the AI produced no company for that contact,
//   * a failing DB write surfaces as a thrown error rather than a silent
//     "applied".
//
// TENANT-ISOLATION NOTE: the four server fns run every query on
// `context.supabase` (the user-scoped RLS client) and filter by id ONLY.
// Isolation is therefore RLS-reliant and cannot be proven by a unit test.
// Two things are asserted instead: (a) the recorded filters carry no
// user_id predicate — pinned so a future refactor that adds one is a
// deliberate change, and (b) when the row is invisible (which is exactly
// what RLS does to another tenant's row) the handler refuses and records
// zero writes. The positive proof belongs in the DB-backed integration
// sweep. `scanContactEnrichmentImpl` is the exception: it takes an explicit
// userId and filters on it, so it is tested directly.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { asSupabaseAdmin, makeContactRow, makeSuggestionRow } from "./__fixtures__/rows";

const fake = makeSupabaseFake();
const rls = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const generateText = vi.fn();
vi.mock("ai", () => ({
  generateText: (args: unknown) => generateText(args),
  Output: { object: (o: unknown) => o },
  NoObjectGeneratedError: { isInstance: () => false },
}));

const getModel = vi.fn(() => ({ modelId: "test-model" }));
vi.mock("@/lib/ai-gateway", () => ({
  getModel: () => getModel(),
  getGateway: () => () => ({ modelId: "test-model" }),
  describeError: (e: unknown) => (e as Error)?.message ?? "unknown",
}));

const searchEmailsParticipantsDecrypted = vi.fn(async () => ({
  rows: [] as Array<{ id: string; from_addr: string | null; from_name: string | null }>,
  error: null as string | null,
}));
const getEmailsDecrypted = vi.fn(async () => ({
  rows: [] as Array<{
    subject: string | null;
    from_name: string | null;
    body_text: string | null;
    snippet: string | null;
  }>,
  error: null as string | null,
}));
vi.mock("../sync/encrypted-reader", () => ({
  searchEmailsParticipantsDecrypted: (...a: unknown[]) =>
    searchEmailsParticipantsDecrypted(...(a as [])),
  getEmailsDecrypted: (...a: unknown[]) => getEmailsDecrypted(...(a as [])),
}));

const setContactEncryptedFields = vi.fn(async () => ({ error: null }));
vi.mock("../sync/encrypted-writer", () => ({
  setContactEncryptedFields: (...a: unknown[]) => setContactEncryptedFields(...(a as [])),
}));

const enqueueUserScanJob = vi.fn(async () => ({ queued: true, alreadyQueued: false }));
vi.mock("./enrich-jobs.server", () => ({
  enqueueUserScanJob: (...a: unknown[]) => enqueueUserScanJob(...(a as [])),
}));

import {
  scanContactEnrichment,
  scanContactEnrichmentImpl,
  listContactEnrichmentSuggestions,
  applyContactEnrichmentSuggestion,
  dismissContactEnrichmentSuggestion,
  undismissContactEnrichmentSuggestion,
} from "./enrich-suggest.functions";

const SUGGESTION_ID = "33333333-3333-4333-8333-333333333333";
const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const VICTIM = "victim-user-2";
const ATTACKER = "attacker-user-9";

type CallArgs = { data?: unknown; context?: Record<string, unknown> };
function call(fn: unknown, args: CallArgs): Promise<never> {
  return (fn as (a: CallArgs) => Promise<never>)(args);
}
const asUser = { supabase: rls.supabaseAdmin };

/** RLS, simulated: a row whose `user_id` is not the caller's simply is not
 * there. Installing this on the fake's select is the closest a unit test
 * can get to the policy, and it is what makes the "foreign suggestion"
 * cases below meaningful rather than vacuous. */
function enforceRlsOnSuggestions(callerId: string) {
  rls.onSelect("contact_enrichment_suggestions", () => ({
    data: rls.rows("contact_enrichment_suggestions").filter((r) => r.user_id === callerId) as Array<
      Record<string, unknown>
    >,
  }));
}

beforeEach(() => {
  fake.reset();
  rls.reset();
  vi.stubEnv("LOVABLE_API_KEY", "test-key");
  generateText.mockReset();
  searchEmailsParticipantsDecrypted.mockReset();
  searchEmailsParticipantsDecrypted.mockResolvedValue({ rows: [], error: null });
  getEmailsDecrypted.mockReset();
  getEmailsDecrypted.mockResolvedValue({ rows: [], error: null });
  setContactEncryptedFields.mockClear();
  enqueueUserScanJob.mockClear();
  getModel.mockClear();
});

describe("applyContactEnrichmentSuggestion", () => {
  it("zod rejects a non-uuid suggestion id before touching the client", async () => {
    await expect(
      applyContactEnrichmentSuggestion({ data: { suggestionId: "nope" } }),
    ).rejects.toThrow();
    expect(rls.calls.selects).toHaveLength(0);
    expect(writeCount(rls)).toBe(0);
  });

  it("another tenant's suggestion is invisible: throws Suggestion not found with zero writes", async () => {
    // RLS-RELIANCE: the handler's own SELECT filters by id only, so the
    // guard here is the policy. The fake stands in for it (see
    // enforceRlsOnSuggestions); the DB-level proof is the integration sweep.
    rls.seed("contact_enrichment_suggestions", [
      makeSuggestionRow({ id: SUGGESTION_ID, user_id: VICTIM, contact_id: CONTACT_ID }),
    ]);
    enforceRlsOnSuggestions(ATTACKER);
    await expect(
      call(applyContactEnrichmentSuggestion, {
        data: { suggestionId: SUGGESTION_ID },
        context: { ...asUser, userId: ATTACKER },
      }),
    ).rejects.toThrow("Suggestion not found");
    expect(writeCount(rls)).toBe(0);
    expect(setContactEncryptedFields).not.toHaveBeenCalled();
  });

  it("applies a company suggestion: patches the contact, marks it applied, dismisses rivals", async () => {
    rls.seed("contact_enrichment_suggestions", [
      makeSuggestionRow({
        id: SUGGESTION_ID,
        contact_id: CONTACT_ID,
        field: "company",
        value: "Acme Corp",
      }),
    ]);

    const res = await call(applyContactEnrichmentSuggestion, {
      data: { suggestionId: SUGGESTION_ID },
      context: asUser,
    });
    expect(res).toEqual({ applied: true });
    expect(rls.calls.updates).toStrictEqual([
      {
        table: "contacts",
        payload: { company: "Acme Corp" },
        options: undefined,
        // RLS-RELIANCE: id only — no user_id predicate.
        filters: [{ op: "eq", col: "id", value: CONTACT_ID, extra: undefined }],
      },
      {
        table: "contact_enrichment_suggestions",
        payload: { status: "applied" },
        options: undefined,
        filters: [{ op: "eq", col: "id", value: SUGGESTION_ID, extra: undefined }],
      },
      {
        table: "contact_enrichment_suggestions",
        payload: { status: "dismissed" },
        options: undefined,
        filters: [
          { op: "eq", col: "contact_id", value: CONTACT_ID, extra: undefined },
          { op: "eq", col: "field", value: "company", extra: undefined },
          { op: "eq", col: "status", value: "pending", extra: undefined },
          { op: "neq", col: "id", value: SUGGESTION_ID, extra: undefined },
        ],
      },
    ]);
    expect(setContactEncryptedFields).not.toHaveBeenCalled();
  });

  it("an email suggestion is lowercased into the patch", async () => {
    rls.seed("contact_enrichment_suggestions", [
      makeSuggestionRow({ id: SUGGESTION_ID, field: "email", value: "Ada@Acme.COM" }),
    ]);
    await call(applyContactEnrichmentSuggestion, {
      data: { suggestionId: SUGGESTION_ID },
      context: asUser,
    });
    expect(rls.calls.updates[0]!.payload).toStrictEqual({ email: "ada@acme.com" });
  });

  it("a phone suggestion goes through the encrypted writer, never the plaintext UPDATE", async () => {
    rls.seed("contact_enrichment_suggestions", [
      makeSuggestionRow({
        id: SUGGESTION_ID,
        contact_id: CONTACT_ID,
        field: "phone",
        value: "+1 (415) 555-0100",
      }),
    ]);
    await call(applyContactEnrichmentSuggestion, {
      data: { suggestionId: SUGGESTION_ID },
      context: asUser,
    });
    expect(setContactEncryptedFields).toHaveBeenCalledWith({
      contact_id: CONTACT_ID,
      phone: "4155550100",
    });
    expect(rls.calls.updates.map((u) => u.table)).toStrictEqual([
      "contact_enrichment_suggestions",
      "contact_enrichment_suggestions",
    ]);
  });

  it("an already-applied suggestion is a no-op with zero writes", async () => {
    rls.seed("contact_enrichment_suggestions", [
      makeSuggestionRow({ id: SUGGESTION_ID, status: "applied" }),
    ]);
    const res = await call(applyContactEnrichmentSuggestion, {
      data: { suggestionId: SUGGESTION_ID },
      context: asUser,
    });
    expect(res).toEqual({ applied: false });
    expect(writeCount(rls)).toBe(0);
  });

  it("a failing contacts UPDATE throws and never marks the suggestion applied", async () => {
    rls.seed("contact_enrichment_suggestions", [
      makeSuggestionRow({ id: SUGGESTION_ID, field: "title", value: "CTO" }),
    ]);
    rls.onUpdate("contacts", () => ({ message: "permission denied for table contacts" }));
    await expect(
      call(applyContactEnrichmentSuggestion, {
        data: { suggestionId: SUGGESTION_ID },
        context: asUser,
      }),
    ).rejects.toThrow("permission denied for table contacts");
    expect(rls.calls.updates.map((u) => u.table)).toStrictEqual(["contacts"]);
  });
});

describe("dismissContactEnrichmentSuggestion", () => {
  it("sets status dismissed, scoped by id (RLS-reliant)", async () => {
    const res = await call(dismissContactEnrichmentSuggestion, {
      data: { suggestionId: SUGGESTION_ID },
      context: asUser,
    });
    expect(res).toEqual({ dismissed: true });
    expect(rls.calls.updates).toStrictEqual([
      {
        table: "contact_enrichment_suggestions",
        payload: { status: "dismissed" },
        options: undefined,
        // RLS-RELIANCE: no user_id predicate — a foreign id is stopped by
        // the policy, which this fake cannot enforce.
        filters: [{ op: "eq", col: "id", value: SUGGESTION_ID, extra: undefined }],
      },
    ]);
  });

  it("a write error surfaces to the caller", async () => {
    rls.onUpdate("contact_enrichment_suggestions", () => ({ message: "row level security" }));
    await expect(
      call(dismissContactEnrichmentSuggestion, {
        data: { suggestionId: SUGGESTION_ID },
        context: asUser,
      }),
    ).rejects.toThrow("row level security");
  });

  it("zod rejects a non-uuid id with zero writes", async () => {
    await expect(
      dismissContactEnrichmentSuggestion({ data: { suggestionId: "x" } }),
    ).rejects.toThrow();
    expect(writeCount(rls)).toBe(0);
  });
});

describe("undismissContactEnrichmentSuggestion", () => {
  it("restores to pending only from the dismissed state", async () => {
    const res = await call(undismissContactEnrichmentSuggestion, {
      data: { suggestionId: SUGGESTION_ID },
      context: asUser,
    });
    expect(res).toEqual({ restored: true });
    expect(rls.calls.updates).toStrictEqual([
      {
        table: "contact_enrichment_suggestions",
        payload: { status: "pending" },
        options: undefined,
        filters: [
          // RLS-RELIANCE: id + status, no user_id predicate.
          { op: "eq", col: "id", value: SUGGESTION_ID, extra: undefined },
          { op: "eq", col: "status", value: "dismissed", extra: undefined },
        ],
      },
    ]);
  });

  it("a write error surfaces to the caller", async () => {
    rls.onUpdate("contact_enrichment_suggestions", () => ({ message: "deadlock detected" }));
    await expect(
      call(undismissContactEnrichmentSuggestion, {
        data: { suggestionId: SUGGESTION_ID },
        context: asUser,
      }),
    ).rejects.toThrow("deadlock detected");
  });
});

describe("listContactEnrichmentSuggestions", () => {
  it("groups rows by contact and defaults to the pending status", async () => {
    const contact = { id: CONTACT_ID, name: "Ada", email: "a@b.co", company: null, title: null };
    rls.seedRaw("contact_enrichment_suggestions", [
      { ...makeSuggestionRow({ id: "s1", contact_id: CONTACT_ID }), contacts: contact },
      {
        ...makeSuggestionRow({ id: "s2", contact_id: CONTACT_ID, field: "title", value: "CTO" }),
        contacts: contact,
      },
    ]);
    const res = (await call(listContactEnrichmentSuggestions, {
      data: {},
      context: asUser,
    })) as unknown as Array<{ contact: { id: string }; suggestions: Array<{ id: string }> }>;
    expect(res).toHaveLength(1);
    expect(res[0]!.contact.id).toBe(CONTACT_ID);
    expect(res[0]!.suggestions.map((s) => s.id)).toStrictEqual(["s1", "s2"]);
    expect(rls.calls.selects[0]!.filters).toStrictEqual([
      { op: "eq", col: "status", value: "pending", extra: undefined },
    ]);
  });

  it("a failing read surfaces to the caller", async () => {
    rls.onSelect("contact_enrichment_suggestions", () => ({ message: "statement timeout" }));
    await expect(
      call(listContactEnrichmentSuggestions, { data: { status: "dismissed" }, context: asUser }),
    ).rejects.toThrow("statement timeout");
  });
});

describe("scanContactEnrichment", () => {
  it("queues a signature_scan job for the authenticated user", async () => {
    const res = await call(scanContactEnrichment, { data: {}, context: asUser });
    expect(res).toEqual({ queued: true, alreadyQueued: false });
    expect(enqueueUserScanJob).toHaveBeenCalledWith(TEST_USER, "signature_scan");
  });

  it("zod rejects an out-of-range strictness", async () => {
    await expect(scanContactEnrichment({ data: { strictness: 9 } })).rejects.toThrow();
    expect(enqueueUserScanJob).not.toHaveBeenCalled();
  });
});

describe("scanContactEnrichmentImpl", () => {
  it("makes no model call and creates nothing when the user has no candidates", async () => {
    fake.seed("contacts", []);
    const res = await scanContactEnrichmentImpl(asSupabaseAdmin(fake), TEST_USER);
    expect(res).toStrictEqual({ scanned: 0, created: 0, run_id: null });
    expect(getModel).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("scopes every candidate read to the caller and ignores other tenants' contacts", async () => {
    fake.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, email: "ada@acme.com" }),
      makeContactRow({ id: "foreign-1", user_id: VICTIM, email: "victim@evil.test" }),
    ]);
    generateText.mockResolvedValue({
      output: { name: null, company: null, title: null, phones: null, emails: null },
    });
    await scanContactEnrichmentImpl(asSupabaseAdmin(fake), TEST_USER);
    const contactsRead = fake.calls.selects.find((s) => s.table === "contacts")!;
    expect(contactsRead.filters).toContainEqual({
      op: "eq",
      col: "user_id",
      value: TEST_USER,
      extra: undefined,
    });
    // The foreign contact was filtered out, so it never reached the model.
    expect(searchEmailsParticipantsDecrypted).toHaveBeenCalledTimes(1);
    expect(searchEmailsParticipantsDecrypted).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER, from: "ada@acme.com" }),
    );
  });

  it("turns a signature extraction into suggestion rows with the caller's user_id", async () => {
    fake.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, email: "ada@acme.com", name: null }),
    ]);
    searchEmailsParticipantsDecrypted.mockResolvedValue({
      rows: [{ id: "e1", from_addr: "ada@acme.com", from_name: "Ada" }],
      error: null,
    });
    getEmailsDecrypted.mockResolvedValue({
      rows: [{ subject: "Hi", from_name: "Ada", body_text: "-- Ada Lovelace", snippet: null }],
      error: null,
    });
    generateText.mockResolvedValue({
      output: {
        name: "Ada Lovelace",
        company: "Analytical Engines",
        title: "Engineer",
        phones: ["+1 (415) 555-0100"],
        emails: ["ada.personal@example.com"],
      },
    });

    const res = await scanContactEnrichmentImpl(asSupabaseAdmin(fake), TEST_USER);
    expect(res.scanned).toBe(1);
    const insert = fake.calls.inserts.find((i) => i.table === "contact_enrichment_suggestions")!;
    const rows = insert.payload as Array<Record<string, unknown>>;
    expect(rows.every((r) => r.user_id === TEST_USER && r.contact_id === CONTACT_ID)).toBe(true);
    expect(rows.map((r) => [r.field, r.value, r.confidence])).toStrictEqual([
      ["name", "Ada Lovelace", "high"],
      ["company", "Analytical Engines", "high"],
      ["title", "Engineer", "high"],
      ["phone", "4155550100", "high"],
      ["email", "ada.personal@example.com", "medium"],
    ]);
    expect(rows.every((r) => r.run_id === res.run_id)).toBe(true);
    expect(res.created).toBe(5);
  });

  it("derives a company from a routable work domain but never from a personal one", async () => {
    fake.seed("contacts", [
      makeContactRow({ id: "c-work", user_id: TEST_USER, email: "sam@northwind.co", name: null }),
      makeContactRow({ id: "c-gmail", user_id: TEST_USER, email: "sam@gmail.com", name: null }),
    ]);
    generateText.mockResolvedValue({
      output: { name: null, company: null, title: null, phones: null, emails: null },
    });
    await scanContactEnrichmentImpl(asSupabaseAdmin(fake), TEST_USER);
    const rows = fake.calls.inserts.find((i) => i.table === "contact_enrichment_suggestions")!
      .payload as Array<Record<string, unknown>>;
    expect(rows).toStrictEqual([
      {
        user_id: TEST_USER,
        contact_id: "c-work",
        run_id: expect.any(String),
        field: "company",
        value: "Northwind",
        source: "domain_derived",
        evidence: "Derived from sam@northwind.co",
        confidence: "low",
      },
    ]);
  });

  it("a dismissed domain_derived company is never re-proposed for that contact", async () => {
    fake.seed("contacts", [
      makeContactRow({ id: "c-work", user_id: TEST_USER, email: "sam@northwind.co", name: null }),
    ]);
    fake.seed("contact_enrichment_suggestions", [
      makeSuggestionRow({
        id: "old",
        contact_id: "c-work",
        user_id: TEST_USER,
        field: "company",
        source: "domain_derived",
        status: "dismissed",
        value: "Something Else",
      }),
    ]);
    generateText.mockResolvedValue({
      output: { name: null, company: null, title: null, phones: null, emails: null },
    });
    const res = await scanContactEnrichmentImpl(asSupabaseAdmin(fake), TEST_USER);
    expect(res.created).toBe(0);
    expect(fake.calls.inserts).toHaveLength(0);
  });

  it("a failing candidate read throws instead of reporting an empty scan", async () => {
    fake.onSelect("contacts", () => ({ message: "connection reset by peer" }));
    await expect(scanContactEnrichmentImpl(asSupabaseAdmin(fake), TEST_USER)).rejects.toThrow(
      "connection reset by peer",
    );
    expect(writeCount(fake)).toBe(0);
  });

  it("a missing LOVABLE_API_KEY throws before any read", async () => {
    vi.stubEnv("LOVABLE_API_KEY", undefined);
    await expect(scanContactEnrichmentImpl(asSupabaseAdmin(fake), TEST_USER)).rejects.toThrow(
      "Missing LOVABLE_API_KEY",
    );
    expect(fake.calls.selects).toHaveLength(0);
  });

  it("a model failure skips that contact rather than aborting the whole scan", async () => {
    fake.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, email: "ada@acme.com", name: null }),
    ]);
    searchEmailsParticipantsDecrypted.mockResolvedValue({
      rows: [{ id: "e1", from_addr: "ada@acme.com", from_name: "Ada" }],
      error: null,
    });
    getEmailsDecrypted.mockResolvedValue({
      rows: [{ subject: "Hi", from_name: "Ada", body_text: "body", snippet: null }],
      error: null,
    });
    generateText.mockRejectedValue(new Error("gateway 503"));
    const res = await scanContactEnrichmentImpl(asSupabaseAdmin(fake), TEST_USER);
    // acme.com is routable and non-personal, so the domain fallback still runs.
    expect(res).toMatchObject({ scanned: 1, created: 1 });
    const rows = fake.calls.inserts[0]!.payload as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ field: "company", source: "domain_derived" });
  });
});
