// Contact CRUD server fns (crud.functions.ts). Contracts protected:
//
//   * zod input contracts per fn — non-uuid ids, oversize fields, bad email
//     formats — and the updateContact email transform (trim + lowercase,
//     "" → null) is pinned via the recorded write payload,
//   * getContact verifies ownership of the decrypt-RPC result BEFORE using
//     it: a row belonging to another user throws "Forbidden" with zero
//     writes (app-level guard on a SECURITY DEFINER RPC — IDOR-critical),
//   * updateContact splits the patch: phone/notes/address_line1/2 never hit
//     the plaintext contacts UPDATE, they go through the encrypted writer;
//     manual_overrides bookkeeping adds tracked fields the user set and
//     drops tracked fields the user cleared,
//   * phones/emails arrays are replace-all with the primary mirrored into
//     the legacy contacts.phone / contacts.email columns,
//   * createContactManual / bulkCreateContactsFromEmails pin user_id from
//     the authenticated context on their service-role upserts.
//
// TENANT-ISOLATION NOTE (feeds the DB-backed integration sweep): the
// handlers below run their contact reads/writes on `context.supabase`
// (the user-scoped RLS client) and filter by `id` ONLY — no `user_id`
// predicate, no app-level ownership guard. Their isolation is therefore
// RLS-reliant and CANNOT be proven by this unit test; the assertions here
// only characterize that no user_id filter is present:
//   - updateContact (overrides pre-read, contacts UPDATE, contact_phones /
//     contact_emails delete+insert)
//   - deleteContact (contacts DELETE by id)
//   - clearContactManualOverrides (not covered here; same pattern)
//   - renameCompanyForContacts scopes by user_id explicitly, but still on
//     the RLS client.
// getContact is the exception: its decrypt RPC runs on the service-role
// client, guarded by the in-handler `row.user_id !== userId` check tested
// below.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";

// Two fakes: `fake` backs the mocked service-role `supabaseAdmin`; `rls`
// plays the user-scoped `context.supabase` the handlers destructure. The
// server-fn stub spreads extra context keys, so each call passes
// `context: { supabase: rls.supabaseAdmin }`.
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

const getContactDecrypted = vi.fn();
const getContactListFieldsDecrypted = vi.fn(async () => ({ rows: [] }));
const getEmailListFieldsDecrypted = vi.fn(
  async (): Promise<{ rows: Array<{ id: string; subject: string | null }> }> => ({ rows: [] }),
);
vi.mock("@/lib/sync/encrypted-reader", () => ({
  getContactDecrypted: (...a: unknown[]) => getContactDecrypted(...(a as [])),
  getContactListFieldsDecrypted: (...a: unknown[]) => getContactListFieldsDecrypted(...(a as [])),
  getEmailListFieldsDecrypted: (...a: unknown[]) => getEmailListFieldsDecrypted(...(a as [])),
}));

const setContactEncryptedFields = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/sync/encrypted-writer", () => ({
  setContactEncryptedFields: (...a: unknown[]) => setContactEncryptedFields(...(a as [])),
}));

const resolveContactCompany = vi.fn();
vi.mock("@/lib/companies/companies.functions", () => ({
  resolveContactCompany: (...a: unknown[]) => resolveContactCompany(...(a as [])),
}));

const reconcileAutoParentsForContacts = vi.fn(async () => {});
vi.mock("@/lib/contacts/auto-company-subgroups.functions", () => ({
  reconcileAutoParentsForContacts: (...a: unknown[]) =>
    reconcileAutoParentsForContacts(...(a as [])),
}));

const applyRulesForContact = vi.fn(async () => {});
vi.mock("@/lib/contacts/group-rules.functions", () => ({
  applyRulesForContact: (...a: unknown[]) => applyRulesForContact(...(a as [])),
}));

const resolveCompanyLogoDomainForContact = vi.fn(async () => "acme.com");
vi.mock("@/lib/contacts/logo-photo.server", () => ({
  resolveCompanyLogoDomainForContact: (...a: unknown[]) =>
    resolveCompanyLogoDomainForContact(...(a as [])),
  getKnownCompanyLogoHashes: async () => new Set<string>(),
  fetchChosenCompanyLogoBytes: async () => null,
  recordCompanyLogoHash: async () => {},
  findMatchingCompanyLogoSha: async () => null,
}));
// avatar_url is null in every getContact fixture, so the self-heal branch
// never runs; these keep an accidental entry into it inert.
vi.mock("@/lib/contacts/photos.server", () => ({
  loadContactPhotoBytes: async () => null,
  sha256Hex: async () => "sha",
  deleteContactPhoto: async () => {},
}));
const getEffectivePhotoPriority = vi.fn(async () => ({
  priority: ["user_upload", "google", "company_logo"],
  source: "account_default",
}));
vi.mock("@/lib/contacts/photo-priority.server", () => ({
  getEffectivePhotoPriority: (...a: unknown[]) => getEffectivePhotoPriority(...(a as [])),
}));

import {
  getContact,
  updateContact,
  deleteContact,
  createContactManual,
  bulkCreateContactsFromEmails,
  computeManualOverrides,
} from "./crud.functions";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ATTACKER = "attacker-user-9";

type CallArgs = { data?: unknown; context?: Record<string, unknown> };
/** Call a stubbed server fn with a context override (the real createServerFn
 * type has no `context` in its call signature — only the stub honors it).
 * Used to hand the handlers a fake user-scoped `context.supabase`. */
function call(fn: unknown, args: CallArgs): Promise<never> {
  return (fn as (a: CallArgs) => Promise<never>)(args);
}
const asUser = { supabase: rls.supabaseAdmin };

function decryptedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTACT_ID,
    user_id: TEST_USER,
    email: "ada@acme.com",
    name: "Ada Lovelace",
    avatar_url: null,
    title: "Engineer",
    company: "Acme",
    phone: "+1 555",
    website: null,
    card_image_url: null,
    address_line1: null,
    address_line2: null,
    city: null,
    region: null,
    postal_code: null,
    country: null,
    linkedin: null,
    twitter: null,
    relationship_summary: null,
    summary_generated_at: null,
    notes: null,
    source: "manual",
    enriched_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  fake.reset();
  rls.reset();
  for (const m of [
    getContactDecrypted,
    getContactListFieldsDecrypted,
    getEmailListFieldsDecrypted,
    setContactEncryptedFields,
    resolveContactCompany,
    reconcileAutoParentsForContacts,
    applyRulesForContact,
    resolveCompanyLogoDomainForContact,
    getEffectivePhotoPriority,
  ]) {
    m.mockClear();
  }
  getContactDecrypted.mockImplementation(async () => ({ row: decryptedRow(), error: null }));
  resolveContactCompany.mockImplementation(async (_ctx: unknown, name: unknown) =>
    name
      ? { companyId: COMPANY_ID, canonicalName: String(name) }
      : { companyId: null, canonicalName: null },
  );
});

describe("computeManualOverrides", () => {
  it("adds set tracked fields, drops cleared ones, ignores untracked keys, sorts", () => {
    const next = computeManualOverrides(["company", "title"], {
      name: "Ada", // tracked, set → added
      company: "", // tracked, cleared (empty string) → removed
      title: undefined, // undefined → left alone (stays)
      notes: null, // tracked, cleared (null) → removed (was absent anyway)
      email: "a@b.co", // NOT tracked → ignored
      id: CONTACT_ID, // NOT tracked → ignored
    });
    expect(next).toEqual(["name", "title"]);
  });
});

describe("getContact", () => {
  it("zod rejects a non-uuid id", async () => {
    await expect(getContact({ data: { id: "not-a-uuid" } })).rejects.toThrow();
    expect(getContactDecrypted).not.toHaveBeenCalled();
  });

  it("owner: returns the decrypted row plus phones, emails, and company info", async () => {
    rls.seed("contacts", [
      {
        id: CONTACT_ID,
        user_id: TEST_USER,
        company_id: COMPANY_ID,
        company_logo_photo_sha: null,
        avatar_source: null,
        photo_priority: null,
      },
    ]);
    rls.seed("companies", [
      { id: COMPANY_ID, user_id: TEST_USER, logo_url: "https://logo.example/acme.png" },
    ]);
    rls.seed("emails", [{ id: "e1", from_addr: "ada@acme.com", received_at: "2026-02-01" }]);
    rls.seed("contact_phones", [
      {
        id: "p1",
        contact_id: CONTACT_ID,
        label: "mobile",
        number: "555",
        is_primary: true,
        position: 0,
      },
    ]);
    rls.seed("contact_emails", [
      {
        id: "m1",
        contact_id: CONTACT_ID,
        label: "home",
        address: "ada@acme.com",
        is_primary: true,
        position: 0,
      },
    ]);
    getEmailListFieldsDecrypted.mockResolvedValueOnce({ rows: [{ id: "e1", subject: "Hello" }] });

    const res = await call(getContact, { data: { id: CONTACT_ID }, context: asUser });
    expect(res).toMatchObject({
      contact: { id: CONTACT_ID, name: "Ada Lovelace", avatar_url: null },
      recentEmails: [{ id: "e1", received_at: "2026-02-01", subject: "Hello" }],
      phones: [{ id: "p1", number: "555" }],
      emails: [{ id: "m1", address: "ada@acme.com" }],
      companyDomain: "acme.com",
      companyId: COMPANY_ID,
      companyPhotoUrl: "https://logo.example/acme.png",
      avatarIsCompanyLogoSnapshot: false,
      photoPrioritySource: "account_default",
    });
    expect(getContactDecrypted).toHaveBeenCalledWith(CONTACT_ID);
  });

  it("IDOR: a decrypt-RPC row owned by another user throws Forbidden with zero writes", async () => {
    // The decrypt RPC is SECURITY DEFINER on the service-role client — it
    // returns the row regardless of caller. The ONLY thing standing between
    // an attacker and the decrypted PII is the in-handler user_id check.
    await expectDeniedCrossUser({
      fake,
      rejects: "Forbidden",
      call: () => impersonate(getContact, ATTACKER)({ data: { id: CONTACT_ID } }),
    });
    // Nothing on the user-scoped client either (the throw precedes any use).
    expect(rls.calls.selects).toHaveLength(0);
  });

  it("an empty decrypt result throws Contact not found", async () => {
    getContactDecrypted.mockResolvedValueOnce({ row: null, error: null });
    await expect(call(getContact, { data: { id: CONTACT_ID }, context: asUser })).rejects.toThrow(
      "Contact not found",
    );
  });
});

describe("updateContact", () => {
  it("zod rejects non-uuid id, oversize fields, and bad email formats", async () => {
    await expect(updateContact({ data: { id: "nope", name: "Ada" } })).rejects.toThrow();
    await expect(
      updateContact({ data: { id: CONTACT_ID, name: "x".repeat(201) } }),
    ).rejects.toThrow();
    await expect(
      updateContact({ data: { id: CONTACT_ID, notes: "x".repeat(5001) } }),
    ).rejects.toThrow();
    await expect(
      updateContact({ data: { id: CONTACT_ID, email: "not-an-email" } }),
    ).rejects.toThrow("Enter a valid email address");
    await expect(
      updateContact({ data: { id: CONTACT_ID, email: `${"a".repeat(250)}@ex.io` } }),
    ).rejects.toThrow("Email is too long");
    // Nothing reached either client.
    expect(rls.calls.updates).toHaveLength(0);
    expect(setContactEncryptedFields).not.toHaveBeenCalled();
  });

  it("clearing an encrypted field asks the writer to CLEAR it, not to keep it", async () => {
    // Regression: `?? undefined` collapsed an explicit null into "field
    // absent", and the RPC treats absent as "keep" — so a phone or note the
    // user emptied reappeared on the next read.
    rls.seed("contacts", [{ id: CONTACT_ID, user_id: TEST_USER, manual_overrides: [] }]);
    await call(updateContact, {
      data: { id: CONTACT_ID, phone: null, notes: null, title: "Engineer" },
      context: asUser,
    });
    expect(setContactEncryptedFields).toHaveBeenCalledWith({
      contact_id: CONTACT_ID,
      phone: null,
      notes: null,
      address_line1: undefined,
      address_line2: undefined,
    });
  });

  it("an empty string clears too, and an omitted field is left alone", async () => {
    rls.seed("contacts", [{ id: CONTACT_ID, user_id: TEST_USER, manual_overrides: [] }]);
    await call(updateContact, {
      data: { id: CONTACT_ID, phone: "" },
      context: asUser,
    });
    expect(setContactEncryptedFields).toHaveBeenCalledWith({
      contact_id: CONTACT_ID,
      phone: "",
      notes: undefined,
      address_line1: undefined,
      address_line2: undefined,
    });
  });

  it("email transform: trimmed + lowercased, and '' becomes null", async () => {
    rls.seed("contacts", [{ id: CONTACT_ID, user_id: TEST_USER, manual_overrides: [] }]);
    await call(updateContact, {
      data: { id: CONTACT_ID, email: "  Ada@Acme.COM  " },
      context: asUser,
    });
    await call(updateContact, { data: { id: CONTACT_ID, email: "" }, context: asUser });
    const [first, second] = rls.calls.updates.filter((u) => u.table === "contacts");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect((first!.payload as { email: string }).email).toBe("ada@acme.com");
    expect((second!.payload as { email: null }).email).toBeNull();
  });

  it("splits the patch: encrypted fields never hit the plaintext UPDATE; scoping is by id only (RLS)", async () => {
    rls.seed("contacts", [{ id: CONTACT_ID, user_id: TEST_USER, manual_overrides: [] }]);
    await call(updateContact, {
      data: {
        id: CONTACT_ID,
        name: "ada lovelace", // normalizeName title-cases an all-lowercase name
        title: "Engineer",
        phone: "+1 555",
        notes: "secret",
        address_line1: "1 Main St",
      },
      context: asUser,
    });
    const upd = rls.calls.updates.find((u) => u.table === "contacts");
    expect(upd).toBeDefined();
    const payload = upd!.payload as Record<string, unknown>;
    expect(payload.name).toBe("Ada Lovelace");
    expect(payload.title).toBe("Engineer");
    // Phase 3: these plaintext columns no longer exist — the handler strips
    // them from the UPDATE and routes them through the encrypted RPC writer.
    expect(payload).not.toHaveProperty("phone");
    expect(payload).not.toHaveProperty("notes");
    expect(payload).not.toHaveProperty("address_line1");
    expect(setContactEncryptedFields).toHaveBeenCalledWith({
      contact_id: CONTACT_ID,
      phone: "+1 555",
      notes: "secret",
      address_line1: "1 Main St",
      address_line2: undefined,
    });
    // RLS-RELIANCE (not provable here): the UPDATE filters by id only —
    // tenant isolation comes from RLS on context.supabase, so this belongs
    // in the DB-backed integration sweep.
    expect(upd!.filters).toEqual([{ op: "eq", col: "id", value: CONTACT_ID }]);
    expect(applyRulesForContact).toHaveBeenCalledWith(rls.supabaseAdmin, TEST_USER, CONTACT_ID);
    // No company in the patch → no auto-subgroup reconcile.
    expect(reconcileAutoParentsForContacts).not.toHaveBeenCalled();
  });

  it("manual_overrides bookkeeping: setting a tracked field adds it, clearing removes it", async () => {
    rls.seed("contacts", [
      { id: CONTACT_ID, user_id: TEST_USER, manual_overrides: ["company", "title"] },
    ]);
    await call(updateContact, {
      data: { id: CONTACT_ID, name: "Grace", company: "" }, // set name, clear company
      context: asUser,
    });
    const upd = rls.calls.updates.find((u) => u.table === "contacts");
    const payload = upd!.payload as Record<string, unknown>;
    // "company" dropped (cleared), "name" added, untouched "title" kept, sorted.
    expect(payload.manual_overrides).toEqual(["name", "title"]);
    // A company key in the patch (even cleared) resolves company_id and
    // reconciles auto-company subgroups.
    expect(payload).toHaveProperty("company_id", null);
    expect(reconcileAutoParentsForContacts).toHaveBeenCalledWith(rls.supabaseAdmin, TEST_USER, [
      CONTACT_ID,
    ]);
  });

  it("phones/emails arrays are replace-all, normalized, with the primary mirrored into the legacy columns", async () => {
    rls.seed("contacts", [{ id: CONTACT_ID, user_id: TEST_USER, manual_overrides: [] }]);
    await call(updateContact, {
      data: {
        id: CONTACT_ID,
        phones: [
          { label: " Mobile ", number: "555 123  4567" },
          { label: "work", number: "555-000-1111", is_primary: true },
        ],
        emails: [{ label: "Home", address: " ADA@Acme.com " }],
      },
      context: asUser,
    });
    // Replace-all: delete by contact_id (no user_id filter — RLS-scoped).
    expect(rls.calls.deletes.map((d) => d.table)).toEqual(["contact_phones", "contact_emails"]);
    expect(rls.calls.deletes[0]!.filters).toEqual([
      { op: "eq", col: "contact_id", value: CONTACT_ID },
    ]);
    const phoneRows = rls.calls.inserts.find((i) => i.table === "contact_phones")!.payload as Array<
      Record<string, unknown>
    >;
    expect(phoneRows).toEqual([
      {
        user_id: TEST_USER,
        contact_id: CONTACT_ID,
        label: "mobile", // trimmed + lowercased
        number: "555 123 4567", // whitespace collapsed by phoneEntrySchema
        is_primary: false,
        position: 0,
      },
      {
        user_id: TEST_USER,
        contact_id: CONTACT_ID,
        label: "work",
        number: "555-000-1111",
        is_primary: true, // explicit primary wins
        position: 1,
      },
    ]);
    const emailRows = rls.calls.inserts.find((i) => i.table === "contact_emails")!.payload as Array<
      Record<string, unknown>
    >;
    expect(emailRows).toEqual([
      {
        user_id: TEST_USER,
        contact_id: CONTACT_ID,
        label: "home",
        address: "ada@acme.com", // trimmed + lowercased by emailEntrySchema
        is_primary: true, // no explicit primary → first row becomes primary
        position: 0,
      },
    ]);
    // Legacy mirrors: primary email lands in the plaintext contacts.email;
    // primary phone routes through the encrypted writer, not the UPDATE.
    const upd = rls.calls.updates.find((u) => u.table === "contacts")!;
    expect((upd.payload as Record<string, unknown>).email).toBe("ada@acme.com");
    expect(upd.payload).not.toHaveProperty("phone");
    expect(setContactEncryptedFields).toHaveBeenCalledWith(
      expect.objectContaining({ contact_id: CONTACT_ID, phone: "555-000-1111" }),
    );
  });
});

describe("deleteContact", () => {
  it("zod rejects a non-uuid id", async () => {
    await expect(deleteContact({ data: { id: "nope" } })).rejects.toThrow();
    expect(rls.calls.deletes).toHaveLength(0);
  });

  it("deletes by id on the user-scoped client (RLS-reliant, no user_id filter)", async () => {
    const res = await call(deleteContact, { data: { id: CONTACT_ID }, context: asUser });
    expect(res).toEqual({ ok: true });
    expect(rls.calls.deletes).toEqual([
      {
        table: "contacts",
        payload: null,
        options: undefined,
        // RLS-RELIANCE: no user_id predicate — isolation is enforced by RLS
        // only; covered by the DB-backed integration sweep, not provable here.
        filters: [{ op: "eq", col: "id", value: CONTACT_ID }],
      },
    ]);
  });
});

describe("createContactManual", () => {
  it("zod rejects a bad email and oversize fields", async () => {
    await expect(createContactManual({ data: { email: "not-an-email" } })).rejects.toThrow();
    await expect(
      createContactManual({ data: { email: "a@b.co", name: "x".repeat(201) } }),
    ).rejects.toThrow();
    expect(fake.calls.upserts).toHaveLength(0);
  });

  it("upserts on the service-role client with user_id pinned from the authenticated context", async () => {
    const res = await call(createContactManual, {
      data: {
        email: " New@Person.IO ", // zod trims + lowercases
        name: "grace hopper", // normalizeName title-cases
        title: "", // empty → null
        company: "Acme",
        phone: "+1 555",
        notes: "met at conf",
      },
      context: asUser,
    });
    const up = fake.calls.upserts.find((u) => u.table === "contacts")!;
    expect(up.payload).toEqual({
      // Tenant safety on the ADMIN client comes from pinning user_id here —
      // a caller can never write into another tenant's (user_id, email) slot.
      user_id: TEST_USER,
      email: "new@person.io",
      name: "Grace Hopper",
      title: null,
      company: "Acme", // canonical name from resolveContactCompany
      company_id: COMPANY_ID,
      website: null,
      linkedin: null,
      twitter: null,
      source: "manual",
      // phone/notes are tracked but excluded from the row — they only exist
      // encrypted; still recorded as manual overrides so enrichment skips them.
      manual_overrides: ["company", "name", "notes", "phone"],
    });
    expect(up.options).toEqual({ onConflict: "user_id,email" });
    // phone/notes go through the encrypted writer keyed by the returned row
    // id (the shared fake echoes the upsert payload, which has no id — a
    // fixture gap; the id argument is asserted in the integration sweep).
    expect(setContactEncryptedFields).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "+1 555", notes: "met at conf" }),
    );
    expect((res as { contact: { email: string } }).contact.email).toBe("new@person.io");
  });
});

describe("bulkCreateContactsFromEmails", () => {
  it("zod rejects an empty list, an oversize list, and a bad email", async () => {
    await expect(bulkCreateContactsFromEmails({ data: { items: [] } })).rejects.toThrow();
    await expect(
      bulkCreateContactsFromEmails({
        data: { items: Array.from({ length: 201 }, (_, i) => ({ email: `u${i}@ex.io` })) },
      }),
    ).rejects.toThrow();
    await expect(
      bulkCreateContactsFromEmails({ data: { items: [{ email: "nope" }] } }),
    ).rejects.toThrow();
    expect(fake.calls.upserts).toHaveLength(0);
  });

  it("upserts normalized rows with user_id pinned and source 'email'", async () => {
    const res = await call(bulkCreateContactsFromEmails, {
      data: {
        items: [
          { email: " Ada@B.CO ", name: "ada lovelace" },
          { email: "c@d.io" }, // no name → null
        ],
      },
      context: asUser,
    });
    const up = fake.calls.upserts.find((u) => u.table === "contacts")!;
    expect(up.payload).toEqual([
      { user_id: TEST_USER, email: "ada@b.co", name: "Ada Lovelace", source: "email" },
      { user_id: TEST_USER, email: "c@d.io", name: null, source: "email" },
    ]);
    expect(up.options).toEqual({ onConflict: "user_id,email", count: "exact" });
    // The fake's write builder returns no count → the handler falls back to
    // rows.length; in production `created` is the upsert's exact count.
    expect(res).toEqual({ created: 2 });
  });
});
