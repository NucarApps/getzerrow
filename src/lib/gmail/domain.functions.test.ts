// Unit tests for the domain move tooling (src/lib/gmail/domain.functions.ts) —
// audit path 8 in docs/rules-engine-audit.md §1 ("Domain move tooling — bulk
// reassign by domain — does not write through the single writer"). Contracts
// pinned here:
//
//   - reassignDomainToFolder writes emails.folder_id only for rows matching
//     the domain (ilike prefilter recorded) AND owned by the caller;
//   - from/to validation: folders must differ, must both exist, and must both
//     belong to the caller — checked before any bookkeeping write;
//   - bookkeeping: a domain filter is ensured on the destination (deduped),
//     source folder_examples for the domain are deleted and mirrored onto the
//     destination, and rows are retagged classified_by "domain_rule";
//   - failure policy (characterized as-is): the destination filter insert
//     happens BEFORE the bulk email update, so a failing update throws but
//     leaves the new domain rule behind; a per-message Gmail label failure is
//     logged and does not abort the batch.
//
// Harness: __fixtures__/server-fn-stub + __fixtures__/supabase-fake, same as
// move.functions.test.ts / reprocess.functions.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";

const fake = makeSupabaseFake();

// -- Harness: the createServerFn chain becomes a plain callable ------------
vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
// The stub ignores middleware; this export only needs to exist for the import.
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));

// -- DB: shared chainable fake (hoist-safe wrapper) ------------------------
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const modifyMessage = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../gmail.server", () => ({
  modifyMessage: (...args: unknown[]) => modifyMessage(...args),
}));

const invalidateAccountContext = vi.fn((_accountId: string) => undefined);
vi.mock("../sync.server", () => ({
  loadOlderFromLabel: vi.fn(),
  invalidateAccountContext: (accountId: string) => invalidateAccountContext(accountId),
}));

vi.mock("../log.server", () => ({
  logError: () => {},
  logInfo: () => {},
  logAudit: () => {},
}));

const updateEmailEncrypted = vi.fn(async (_input: unknown) => ({ error: null as string | null }));
const insertFolderExampleEncrypted = vi.fn(async (_input: unknown) => ({
  error: null as string | null,
}));
vi.mock("../sync/encrypted-writer", () => ({
  updateEmailEncrypted: (input: unknown) => updateEmailEncrypted(input),
  insertFolderExampleEncrypted: (input: unknown) => insertFolderExampleEncrypted(input),
}));

import { addDomainFilter, reassignDomainToFolder } from "./domain.functions";

const FROM = "11111111-1111-4111-8111-111111111111";
const TO = "22222222-2222-4222-8222-222222222222";
const EMAIL_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMAIL_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function seedFolders(overrides?: { toUser?: string }) {
  fake.seed("folders", [
    {
      id: FROM,
      user_id: TEST_USER,
      name: "Old",
      gmail_label_id: "L-FROM",
      gmail_account_id: ACC,
    },
    {
      id: TO,
      user_id: overrides?.toUser ?? TEST_USER,
      name: "New",
      gmail_label_id: "L-TO",
      gmail_account_id: ACC,
    },
  ]);
}

function seedMatchingEmails() {
  fake.seed("emails", [
    {
      id: EMAIL_1,
      user_id: TEST_USER,
      folder_id: FROM,
      from_addr: "a@acme.com",
      gmail_message_id: "gm-1",
      gmail_account_id: ACC,
    },
    {
      id: EMAIL_2,
      user_id: TEST_USER,
      folder_id: FROM,
      from_addr: "b@acme.com",
      gmail_message_id: "gm-2",
      gmail_account_id: ACC,
    },
    // Another user's email in the same folder id + domain: the user_id scope
    // on the select must keep it out of the bulk update.
    {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      user_id: "someone-else",
      folder_id: FROM,
      from_addr: "c@acme.com",
      gmail_message_id: "gm-3",
      gmail_account_id: "acc-other",
    },
  ]);
}

beforeEach(() => {
  fake.reset();
  modifyMessage.mockClear();
  modifyMessage.mockResolvedValue({});
  invalidateAccountContext.mockClear();
  updateEmailEncrypted.mockClear();
  updateEmailEncrypted.mockResolvedValue({ error: null });
  insertFolderExampleEncrypted.mockClear();
  insertFolderExampleEncrypted.mockResolvedValue({ error: null });
});

describe("reassignDomainToFolder", () => {
  it("rejects identical from/to folders before touching the database", async () => {
    await expect(
      reassignDomainToFolder({
        data: { from_folder_id: FROM, to_folder_id: FROM, domain: "acme.com" },
      }),
    ).rejects.toThrow("Folders must differ");
    expect(fake.calls.selects).toHaveLength(0);
    expect(fake.calls.inserts).toHaveLength(0);
    expect(fake.calls.updates).toHaveLength(0);
  });

  it("requires BOTH folders to exist and belong to the caller before any bookkeeping write", async () => {
    // Destination owned by another user → denied, nothing written.
    seedFolders({ toUser: "someone-else" });
    await expect(
      reassignDomainToFolder({
        data: { from_folder_id: FROM, to_folder_id: TO, domain: "acme.com" },
      }),
    ).rejects.toThrow("Not authorized");
    expect(fake.calls.inserts).toHaveLength(0);
    expect(fake.calls.updates).toHaveLength(0);

    // Same denial when the caller is impersonating on someone else's folders.
    fake.reset();
    seedFolders();
    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(
          reassignDomainToFolder,
          "intruder",
        )({ data: { from_folder_id: FROM, to_folder_id: TO, domain: "acme.com" } }),
      rejects: "Not authorized",
    });

    // And a missing destination folder is the same error.
    fake.reset();
    fake.seed("folders", [
      { id: FROM, user_id: TEST_USER, name: "Old", gmail_label_id: null, gmail_account_id: ACC },
    ]);
    await expect(
      reassignDomainToFolder({
        data: { from_folder_id: FROM, to_folder_id: TO, domain: "acme.com" },
      }),
    ).rejects.toThrow("Not authorized");
  });

  it("does not reassign a look-alike domain that only passes the ilike prefilter", async () => {
    // `%@acme.com%` also matches `x@acme.com.evil.com`; the exact host check
    // must exclude it (regression — this path used to trust the ilike).
    seedFolders();
    const LOOKALIKE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    fake.seed("emails", [
      {
        id: EMAIL_1,
        user_id: TEST_USER,
        folder_id: FROM,
        from_addr: "a@acme.com",
        gmail_message_id: "gm-1",
        gmail_account_id: ACC,
      },
      {
        id: LOOKALIKE,
        user_id: TEST_USER,
        folder_id: FROM,
        from_addr: "x@acme.com.evil.com",
        gmail_message_id: "gm-9",
        gmail_account_id: ACC,
      },
    ]);
    const res = await reassignDomainToFolder({
      data: { from_folder_id: FROM, to_folder_id: TO, domain: "acme.com" },
    });
    expect(res).toEqual({ moved: 1 });
    const emailUpdates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(emailUpdates[0]!.filters).toEqual([{ op: "in", col: "id", value: [EMAIL_1] }]);
    expect(updateEmailEncrypted).toHaveBeenCalledTimes(1);
  });

  it("bulk-reassigns only the caller's rows in the source folder and performs the full bookkeeping", async () => {
    seedFolders();
    seedMatchingEmails();
    fake.seed("folder_examples", [
      {
        id: "ex-1",
        folder_id: FROM,
        from_addr: "a@acme.com",
        gmail_message_id: "gm-1",
        gmail_account_id: ACC,
      },
    ]);

    const res = await reassignDomainToFolder({
      // Uppercase input pins the lowercasing of the stored rule value.
      data: { from_folder_id: FROM, to_folder_id: TO, domain: "Acme.COM" },
    });
    expect(res).toEqual({ moved: 2 });

    // 1) Domain rule added to the destination folder (lowercased).
    const filterInserts = fake.calls.inserts.filter((i) => i.table === "folder_filters");
    expect(filterInserts).toHaveLength(1);
    expect(filterInserts[0]!.payload).toEqual({
      folder_id: TO,
      field: "domain",
      op: "contains",
      value: "acme.com",
    });

    // 2) The candidate query is scoped to the caller + source folder + domain.
    const emailSelect = fake.calls.selects.find((s) => s.table === "emails");
    expect(emailSelect?.filters).toEqual([
      { op: "eq", col: "user_id", value: TEST_USER },
      { op: "eq", col: "folder_id", value: FROM },
      { op: "ilike", col: "from_addr", value: "%@acme.com%" },
    ]);

    // 3) The bulk write retags exactly the caller's two rows — never the
    //    other user's row that shares the folder id and domain.
    const emailUpdates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(emailUpdates).toHaveLength(1);
    expect(emailUpdates[0]!.payload).toEqual({
      folder_id: TO,
      classified_by: "domain_rule",
      ai_confidence: 1,
    });
    expect(emailUpdates[0]!.filters).toEqual([{ op: "in", col: "id", value: [EMAIL_1, EMAIL_2] }]);
    expect(updateEmailEncrypted.mock.calls.map((c) => c[0])).toEqual([
      { email_id: EMAIL_1, classification_reason: "Domain rule: acme.com → New" },
      { email_id: EMAIL_2, classification_reason: "Domain rule: acme.com → New" },
    ]);

    // 4) Gmail labels swapped per message (best effort).
    expect(modifyMessage).toHaveBeenCalledTimes(2);
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-1", ["L-TO"], ["L-FROM"]);
    expect(modifyMessage).toHaveBeenCalledWith(ACC, "gm-2", ["L-TO"], ["L-FROM"]);

    // 5) Source examples for the domain removed and mirrored onto the
    //    destination so its learned signal follows the move.
    const exampleDeletes = fake.calls.deletes.filter((d) => d.table === "folder_examples");
    expect(exampleDeletes).toHaveLength(1);
    expect(exampleDeletes[0]!.filters).toEqual([{ op: "in", col: "id", value: ["ex-1"] }]);
    expect(insertFolderExampleEncrypted).toHaveBeenCalledWith({
      folder_id: TO,
      user_id: TEST_USER,
      gmail_account_id: ACC,
      gmail_message_id: "gm-1",
      from_addr: "a@acme.com",
      subject: null,
      snippet: null,
      source: "reassigned",
    });
  });

  it("dedupes the destination domain rule: an existing filter row means no second insert", async () => {
    seedFolders();
    fake.seed("folder_filters", [
      { id: "ff-1", folder_id: TO, field: "domain", op: "contains", value: "acme.com" },
    ]);
    const res = await reassignDomainToFolder({
      data: { from_folder_id: FROM, to_folder_id: TO, domain: "acme.com" },
    });
    expect(res).toEqual({ moved: 0 });
    expect(fake.calls.inserts).toHaveLength(0);
  });

  it("CHARACTERIZATION: a failing bulk update throws AFTER the domain rule was inserted (partial bookkeeping remains)", async () => {
    seedFolders();
    seedMatchingEmails();
    fake.onUpdate("emails", () => ({ message: "db unavailable" }));

    await expect(
      reassignDomainToFolder({
        data: { from_folder_id: FROM, to_folder_id: TO, domain: "acme.com" },
      }),
    ).rejects.toThrow("db unavailable");

    // The destination domain filter was already written — the rule survives
    // even though no email moved. Pinned as current (non-transactional)
    // behavior; the Phase B single-writer routing is the intended fix.
    const filterInserts = fake.calls.inserts.filter((i) => i.table === "folder_filters");
    expect(filterInserts).toHaveLength(1);
    // Nothing after the failed update ran: no reasons, labels, or example moves.
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
    expect(modifyMessage).not.toHaveBeenCalled();
    expect(fake.calls.deletes).toHaveLength(0);
  });

  it("a per-message Gmail label failure is swallowed — the reassignment still reports every row moved", async () => {
    seedFolders();
    seedMatchingEmails();
    modifyMessage
      .mockRejectedValueOnce(new Error("Gmail API error 404: Not Found"))
      .mockResolvedValueOnce({});

    const res = await reassignDomainToFolder({
      data: { from_folder_id: FROM, to_folder_id: TO, domain: "acme.com" },
    });
    // The DB move already happened for both rows; the label sync is best
    // effort, so the 404 on gm-1 is logged and the batch continues.
    expect(res).toEqual({ moved: 2 });
    expect(modifyMessage).toHaveBeenCalledTimes(2);
  });
});

describe("addDomainFilter", () => {
  it("refuses a folder owned by another user before inserting", async () => {
    fake.seed("folders", [{ id: TO, user_id: "someone-else", name: "New", gmail_account_id: ACC }]);
    await expect(addDomainFilter({ data: { folder_id: TO, domain: "acme.com" } })).rejects.toThrow(
      "Not authorized",
    );
    expect(fake.calls.inserts).toHaveLength(0);
    expect(invalidateAccountContext).not.toHaveBeenCalled();
  });

  it("inserts the lowercased domain rule and busts the account-context cache", async () => {
    fake.seed("folders", [{ id: TO, user_id: TEST_USER, name: "New", gmail_account_id: ACC }]);
    const res = await addDomainFilter({ data: { folder_id: TO, domain: "Acme.COM" } });
    expect(res).toEqual({ ok: true });
    const inserts = fake.calls.inserts.filter((i) => i.table === "folder_filters");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload).toEqual({
      folder_id: TO,
      field: "domain",
      op: "contains",
      value: "acme.com",
    });
    expect(invalidateAccountContext).toHaveBeenCalledWith(ACC);
  });
});
