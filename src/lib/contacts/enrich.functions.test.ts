// AI contact enrichment (enrich.functions.ts). Contracts protected:
//
//   * runEnrichForContact filters the contact read by (id, user_id) — the
//     helper is handed supabaseAdmin by the background worker, so the user
//     scope must never be implicit,
//   * manual_overrides (and an explicit company link) are respected: a
//     locked field is never overwritten, even with force,
//   * phone / address lines are persisted ONLY through the encrypted
//     writer and are stripped from the plaintext UPDATE,
//   * a model failure degrades to "enriched_at only" instead of writing
//     garbage, and a failing UPDATE surfaces rather than being swallowed,
//   * addContactFromEmail refuses another tenant's email id with zero
//     writes, and pins the upsert payload (lowercased address, user_id
//     from the authenticated context),
//   * the identity-briefing prompt tells the model to discount the
//     personal-mail providers as a company signal.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { makeContactRow } from "./__fixtures__/rows";
import { PERSONAL_DOMAINS } from "@/lib/company-domains";

const fake = makeSupabaseFake({ applyWrites: true });
const rls = makeSupabaseFake({ applyWrites: true });

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
}));

// getModel comes from ai-gateway (contacts-helpers.server only re-exports
// it), so stubbing the gateway keeps the real EXTRACT_SCHEMA, normalizeName
// and pickBetterName in play — the name/locking behaviour under test.
vi.mock("@/lib/ai-gateway", () => ({
  getModel: () => ({ modelId: "test-model" }),
  getGateway: () => () => ({ modelId: "test-model" }),
  describeError: (e: unknown) => (e as Error)?.message ?? "unknown",
}));

const fetchFromGmail = vi.fn<typeof import("../contacts-helpers.server").fetchFromGmail>();
vi.mock("../contacts-helpers.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contacts-helpers.server")>();
  return {
    ...actual,
    fetchFromGmail: (...a: Parameters<typeof fetchFromGmail>) => fetchFromGmail(...a),
  };
});

const getEmailsDecrypted = vi.fn(async () => ({
  rows: [] as Array<Record<string, unknown>>,
  error: null as string | null,
}));
const getContactDecrypted = vi.fn(async () => ({
  row: null as Record<string, unknown> | null,
  error: null as string | null,
}));
vi.mock("../sync/encrypted-reader", () => ({
  getEmailsDecrypted: (...a: unknown[]) => getEmailsDecrypted(...(a as [])),
  getContactDecrypted: (...a: unknown[]) => getContactDecrypted(...(a as [])),
}));

const setContactEncryptedFields = vi.fn(async () => ({ error: null }));
vi.mock("../sync/encrypted-writer", () => ({
  setContactEncryptedFields: (...a: unknown[]) => setContactEncryptedFields(...(a as [])),
}));

import {
  runEnrichForContact,
  enrichContact,
  rerunEnrichmentBatch,
  listContactIdsForRerun,
  addContactFromEmail,
} from "./enrich.functions";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const EMAIL_ID = "44444444-4444-4444-8444-444444444444";
const VICTIM = "victim-user-2";
const ATTACKER = "attacker-user-9";

type CallArgs = { data?: unknown; context?: Record<string, unknown> };
function call(fn: unknown, args: CallArgs): Promise<never> {
  return (fn as (a: CallArgs) => Promise<never>)(args);
}
const asUser = { supabase: rls.supabaseAdmin };
const asAttacker = { supabase: rls.supabaseAdmin, userId: ATTACKER };
/** The fake under the client type runEnrichForContact declares. */
type EnrichCtx = Parameters<typeof runEnrichForContact>[0];
const ctx = (userId = TEST_USER): EnrichCtx =>
  ({ supabase: rls.supabaseAdmin, userId }) as unknown as EnrichCtx;

/** One decrypted message with a signature-shaped tail, enough to get past
 * the "no sample" early return. */
function signatureEmail(over: Record<string, unknown> = {}) {
  return {
    id: "e1",
    user_id: TEST_USER,
    subject: "Proposal",
    from_addr: "ada@acme.com",
    from_name: "Ada Lovelace",
    to_addrs: "me@self.io",
    received_at: "2026-02-01T00:00:00Z",
    snippet: null,
    body_text:
      "Here is the proposal.\n\nBest,\n--\nAda Lovelace\nChief Engineer, Acme\n+1 415 555 0100\nhttps://linkedin.com/in/ada\n",
    ...over,
  };
}

const EMPTY_EXTRACTION = {
  name: null,
  title: null,
  company: null,
  phone: null,
  website: null,
  linkedin: null,
  twitter: null,
  address_line1: null,
  address_line2: null,
  city: null,
  region: null,
  postal_code: null,
  country: null,
  ai_category: null,
};

beforeEach(() => {
  fake.reset();
  rls.reset();
  generateText.mockReset();
  // Structured extraction first, then the free-text identity briefing.
  generateText.mockResolvedValue({ output: { ...EMPTY_EXTRACTION }, text: "" });
  fetchFromGmail.mockReset();
  fetchFromGmail.mockResolvedValue([]);
  getEmailsDecrypted.mockReset();
  getEmailsDecrypted.mockResolvedValue({ rows: [], error: null });
  getContactDecrypted.mockReset();
  getContactDecrypted.mockResolvedValue({ row: null, error: null });
  setContactEncryptedFields.mockClear();
});

describe("runEnrichForContact", () => {
  it("refuses a contact owned by another tenant, writing nothing", async () => {
    rls.seed("contacts", [makeContactRow({ id: CONTACT_ID, user_id: VICTIM })]);
    await expect(runEnrichForContact(ctx(ATTACKER), CONTACT_ID, false)).rejects.toThrow(
      "Contact not found",
    );
    expect(writeCount(rls)).toBe(0);
    expect(generateText).not.toHaveBeenCalled();
    const read = rls.calls.selects[0]!;
    expect(read.filters).toStrictEqual([
      { op: "eq", col: "id", value: CONTACT_ID, extra: undefined },
      { op: "eq", col: "user_id", value: ATTACKER, extra: undefined },
    ]);
  });

  it("a contact with no email is returned untouched as skipped", async () => {
    rls.seed("contacts", [makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, email: null })]);
    const res = await runEnrichForContact(ctx(), CONTACT_ID, false);
    expect(res.skipped).toBe(true);
    expect(writeCount(rls)).toBe(0);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("a recently enriched contact is skipped unless force is set", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    rls.seed("contacts", [
      makeContactRow({
        id: CONTACT_ID,
        user_id: TEST_USER,
        enriched_at: "2026-02-20T00:00:00Z",
      }),
    ]);
    const res = await runEnrichForContact(ctx(), CONTACT_ID, false);
    expect(res.skipped).toBe(true);
    expect(generateText).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("writes the extracted plaintext fields and routes phone/address to the encrypted writer", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, name: null, email: "ada@acme.com" }),
    ]);
    rls.seed("emails", [
      { id: "e1", user_id: TEST_USER, from_addr: "ada@acme.com", received_at: "2026-02-01" },
    ]);
    getEmailsDecrypted.mockResolvedValue({ rows: [signatureEmail()], error: null });
    generateText
      .mockResolvedValueOnce({
        output: {
          ...EMPTY_EXTRACTION,
          name: "Ada Lovelace",
          title: "Chief Engineer",
          company: "Acme",
          phone: "+14155550100",
          address_line1: "1 Analytical Way",
          ai_category: "software",
        },
      })
      .mockResolvedValueOnce({ text: "Ada is Acme's chief engineer." });

    await runEnrichForContact(ctx(), CONTACT_ID, false);

    const upd = rls.calls.updates.find((u) => u.table === "contacts")!;
    const payload = upd.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      name: "Ada Lovelace",
      title: "Chief Engineer",
      company: "Acme",
      ai_category: "software",
    });
    // Encrypted-only columns never reach the plaintext UPDATE.
    expect(payload).not.toHaveProperty("phone");
    expect(payload).not.toHaveProperty("address_line1");
    expect(payload).not.toHaveProperty("relationship_summary");
    expect(setContactEncryptedFields).toHaveBeenCalledWith({
      contact_id: CONTACT_ID,
      phone: "+14155550100",
      relationship_summary: "Ada is Acme's chief engineer.",
      address_line1: "1 Analytical Way",
      address_line2: undefined,
    });
  });

  it("never overwrites a manually overridden field, even with force", async () => {
    rls.seed("contacts", [
      makeContactRow({
        id: CONTACT_ID,
        user_id: TEST_USER,
        name: "Ada L.",
        title: "Founder",
        email: "ada@acme.com",
        manual_overrides: ["name", "title"],
      }),
    ]);
    rls.seed("emails", [
      { id: "e1", user_id: TEST_USER, from_addr: "ada@acme.com", received_at: "2026-02-01" },
    ]);
    getEmailsDecrypted.mockResolvedValue({ rows: [signatureEmail()], error: null });
    generateText.mockResolvedValue({
      output: { ...EMPTY_EXTRACTION, name: "Ada Lovelace", title: "Chief Engineer" },
      text: "",
    });

    await runEnrichForContact(ctx(), CONTACT_ID, true);
    const payload = rls.calls.updates.find((u) => u.table === "contacts")!.payload as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("title");
    expect(payload).toHaveProperty("enriched_at");
  });

  it("an explicit company link locks the company text without a manual override", async () => {
    rls.seed("contacts", [
      makeContactRow({
        id: CONTACT_ID,
        user_id: TEST_USER,
        company: "Acme",
        company_id: "company-1",
        email: "ada@acme.com",
      }),
    ]);
    rls.seed("emails", [
      { id: "e1", user_id: TEST_USER, from_addr: "ada@acme.com", received_at: "2026-02-01" },
    ]);
    getEmailsDecrypted.mockResolvedValue({ rows: [signatureEmail()], error: null });
    generateText.mockResolvedValue({
      output: { ...EMPTY_EXTRACTION, company: "Acme Holdings LLC" },
      text: "",
    });
    await runEnrichForContact(ctx(), CONTACT_ID, true);
    const payload = rls.calls.updates.find((u) => u.table === "contacts")!.payload as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty("company");
  });

  it("a model failure stamps enriched_at and writes no extracted values", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, name: null, email: "ada@acme.com" }),
    ]);
    rls.seed("emails", [
      { id: "e1", user_id: TEST_USER, from_addr: "ada@acme.com", received_at: "2026-02-01" },
    ]);
    getEmailsDecrypted.mockResolvedValue({ rows: [signatureEmail()], error: null });
    generateText.mockRejectedValue(new Error("gateway 503"));

    await runEnrichForContact(ctx(), CONTACT_ID, true);
    const payload = rls.calls.updates.find((u) => u.table === "contacts")!.payload as Record<
      string,
      unknown
    >;
    // Only the from_name-derived name survives; no title/company/category.
    expect(Object.keys(payload).sort()).toStrictEqual(["enriched_at", "name"]);
    expect(payload.name).toBe("Ada Lovelace");
    expect(setContactEncryptedFields).toHaveBeenCalledWith({
      contact_id: CONTACT_ID,
      phone: undefined,
      relationship_summary: undefined,
      address_line1: undefined,
      address_line2: undefined,
    });
  });

  it("a failing contacts UPDATE surfaces instead of reporting success", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, email: "ada@acme.com" }),
    ]);
    rls.seed("emails", [
      { id: "e1", user_id: TEST_USER, from_addr: "ada@acme.com", received_at: "2026-02-01" },
    ]);
    getEmailsDecrypted.mockResolvedValue({ rows: [signatureEmail()], error: null });
    rls.onUpdate("contacts", () => ({ message: "deadlock detected" }));
    await expect(runEnrichForContact(ctx(), CONTACT_ID, true)).rejects.toThrow("deadlock detected");
    expect(setContactEncryptedFields).not.toHaveBeenCalled();
  });

  it("tells the model to discount the personal-mail providers as company signal", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, email: "ada@gmail.com" }),
    ]);
    rls.seed("emails", [
      { id: "e1", user_id: TEST_USER, from_addr: "ada@gmail.com", received_at: "2026-02-01" },
    ]);
    getEmailsDecrypted.mockResolvedValue({
      rows: [signatureEmail({ from_addr: "ada@gmail.com" })],
      error: null,
    });
    await runEnrichForContact(ctx(), CONTACT_ID, true);
    const briefing = generateText.mock.calls.at(-1)![0] as { prompt: string };
    expect(briefing.prompt).toContain("Ignore generic providers");
    for (const d of ["gmail.com", "outlook.com"]) {
      expect(PERSONAL_DOMAINS.has(d), `${d} must be a known personal domain`).toBe(true);
      expect(briefing.prompt).toContain(d);
    }
  });

  it("falls back to Gmail only when local mail history is empty", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, email: "ada@acme.com" }),
    ]);
    rls.seed("gmail_accounts", [{ id: "acct-1", user_id: TEST_USER }]);
    await runEnrichForContact(ctx(), CONTACT_ID, true);
    expect(fetchFromGmail).toHaveBeenCalledWith(["acct-1"], "from:ada@acme.com", 20);
  });
});

describe("enrichContact", () => {
  it("passes the authenticated context through to the shared core", async () => {
    rls.seed("contacts", [makeContactRow({ id: CONTACT_ID, user_id: VICTIM })]);
    await expect(
      call(enrichContact, { data: { id: CONTACT_ID }, context: asAttacker }),
    ).rejects.toThrow("Contact not found");
    expect(writeCount(rls)).toBe(0);
  });

  it("zod rejects a non-uuid id", async () => {
    await expect(enrichContact({ data: { id: "nope" } })).rejects.toThrow();
    expect(rls.calls.selects).toHaveLength(0);
  });
});

describe("rerunEnrichmentBatch", () => {
  it("reports per-id outcomes and never lets one failure sink the batch", async () => {
    rls.seed("contacts", [
      // No email → skipped.
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, email: null }),
      // Another tenant's id → failed, with the reason surfaced.
      makeContactRow({ id: OTHER_CONTACT_ID, user_id: VICTIM }),
    ]);
    const res = (await call(rerunEnrichmentBatch, {
      data: { ids: [CONTACT_ID, OTHER_CONTACT_ID] },
      context: asUser,
    })) as unknown as { processed: number; skipped: number; failed: Array<{ id: string }> };
    expect(res.skipped).toBe(1);
    expect(res.processed).toBe(0);
    expect(res.failed).toStrictEqual([{ id: OTHER_CONTACT_ID, error: "Contact not found" }]);
  });

  it("zod rejects an empty batch and a batch over the chunk cap", async () => {
    await expect(rerunEnrichmentBatch({ data: { ids: [] } })).rejects.toThrow();
    await expect(
      rerunEnrichmentBatch({ data: { ids: Array.from({ length: 16 }, () => CONTACT_ID) } }),
    ).rejects.toThrow();
  });
});

describe("listContactIdsForRerun", () => {
  it("returns only the caller's contacts that have an email", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, email: "ada@acme.com" }),
      makeContactRow({ id: "no-email", user_id: TEST_USER, email: null }),
      makeContactRow({ id: OTHER_CONTACT_ID, user_id: VICTIM, email: "v@evil.test" }),
    ]);
    const res = (await call(listContactIdsForRerun, { data: {}, context: asUser })) as unknown as {
      ids: string[];
    };
    expect(res.ids).toStrictEqual([CONTACT_ID]);
  });

  it("a failing read surfaces to the caller", async () => {
    rls.onSelect("contacts", () => ({ message: "statement timeout" }));
    await expect(call(listContactIdsForRerun, { data: {}, context: asUser })).rejects.toThrow(
      "statement timeout",
    );
  });
});

describe("addContactFromEmail", () => {
  it("refuses another tenant's email id before creating anything", async () => {
    getEmailsDecrypted.mockResolvedValue({
      rows: [signatureEmail({ id: EMAIL_ID, user_id: VICTIM })],
      error: null,
    });
    await expect(
      call(addContactFromEmail, { data: { emailId: EMAIL_ID }, context: asAttacker }),
    ).rejects.toThrow("Not authorized");
    expect(writeCount(fake)).toBe(0);
    expect(writeCount(rls)).toBe(0);
  });

  it("upserts the sender with a lowercased address and the caller's user_id", async () => {
    getEmailsDecrypted.mockResolvedValue({
      rows: [
        signatureEmail({ id: EMAIL_ID, from_addr: "  Ada@ACME.com ", from_name: "ada lovelace" }),
      ],
      error: null,
    });
    fake.onUpsert("contacts", () => ({
      data: makeContactRow({
        id: CONTACT_ID,
        user_id: TEST_USER,
        email: "ada@acme.com",
        name: null,
      }),
    }));
    generateText.mockResolvedValue({
      output: { ...EMPTY_EXTRACTION, title: "Chief Engineer", phone: "+14155550100" },
    });
    getContactDecrypted.mockResolvedValue({ row: { id: CONTACT_ID }, error: null });

    await call(addContactFromEmail, { data: { emailId: EMAIL_ID }, context: asUser });

    const up = fake.calls.upserts.find((u) => u.table === "contacts")!;
    expect(up.payload).toStrictEqual({
      user_id: TEST_USER,
      email: "ada@acme.com",
      name: "Ada Lovelace",
      source: "email",
    });
    expect(up.options).toStrictEqual({ onConflict: "user_id,email" });
    // Plaintext patch on the user-scoped client; phone only via the writer.
    const payload = rls.calls.updates.find((u) => u.table === "contacts")!.payload as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({ title: "Chief Engineer" });
    expect(payload).not.toHaveProperty("phone");
    expect(setContactEncryptedFields).toHaveBeenCalledWith({
      contact_id: CONTACT_ID,
      phone: "+14155550100",
      address_line1: undefined,
      address_line2: undefined,
    });
  });

  it("an email with no sender address is rejected without writing", async () => {
    getEmailsDecrypted.mockResolvedValue({
      rows: [signatureEmail({ id: EMAIL_ID, from_addr: null })],
      error: null,
    });
    await expect(
      call(addContactFromEmail, { data: { emailId: EMAIL_ID }, context: asUser }),
    ).rejects.toThrow("no sender address");
    expect(writeCount(fake)).toBe(0);
  });

  it("a failing upsert surfaces as Could not save contact", async () => {
    getEmailsDecrypted.mockResolvedValue({
      rows: [signatureEmail({ id: EMAIL_ID })],
      error: null,
    });
    fake.onUpsert("contacts", () => ({ message: "unique violation" }));
    await expect(
      call(addContactFromEmail, { data: { emailId: EMAIL_ID }, context: asUser }),
    ).rejects.toThrow("unique violation");
    expect(setContactEncryptedFields).not.toHaveBeenCalled();
  });

  it("a missing email id is rejected", async () => {
    getEmailsDecrypted.mockResolvedValue({ rows: [], error: null });
    await expect(
      call(addContactFromEmail, { data: { emailId: EMAIL_ID }, context: asUser }),
    ).rejects.toThrow("Email not found");
  });
});
