// Contact sharing and the picker helpers (share.functions.ts). Contracts
// protected:
//
//   * shareContactByEmail decrypts through a SECURITY DEFINER RPC that
//     ignores the caller, so the in-handler user_id check is the ONLY thing
//     between an attacker and another tenant's PII being MAILED OUT: a
//     foreign contact id must reject before any Gmail send,
//   * the share payload carries the decrypted fields verbatim and is sent
//     from the caller's own oldest Gmail account,
//   * a user with no connected Gmail account gets a clear error and no send,
//   * listUniqueInboxSenders excludes addresses that already exist as
//     contacts and non-human senders, and honours search/limit.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { makeContactRow } from "./__fixtures__/rows";

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

const sendContactShareEmail = vi.fn(async () => {});
vi.mock("../cards.server", () => ({
  sendContactShareEmail: (...a: unknown[]) => sendContactShareEmail(...(a as [])),
}));

const getContactDecrypted = vi.fn(async () => ({
  row: null as Record<string, unknown> | null,
  error: null as string | null,
}));
vi.mock("../sync/encrypted-reader", () => ({
  getContactDecrypted: (...a: unknown[]) => getContactDecrypted(...(a as [])),
}));

import {
  shareContactByEmail,
  listFoldersForPicker,
  listUniqueInboxSenders,
} from "./share.functions";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const VICTIM = "victim-user-2";
const ATTACKER = "attacker-user-9";

type CallArgs = { data?: unknown; context?: Record<string, unknown> };
function call(fn: unknown, args: CallArgs): Promise<never> {
  return (fn as (a: CallArgs) => Promise<never>)(args);
}
const asUser = { supabase: rls.supabaseAdmin };
const asAttacker = { supabase: rls.supabaseAdmin, userId: ATTACKER };

/** The decrypt RPC's shape: the plaintext row plus the encrypted columns
 * rehydrated. */
function decrypted(over: Record<string, unknown> = {}) {
  return {
    ...makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, name: "Ada Lovelace" }),
    phone: "+14155550100",
    notes: "private",
    address_line1: "1 Analytical Way",
    address_line2: null,
    relationship_summary: null,
    ...over,
  };
}

beforeEach(() => {
  fake.reset();
  rls.reset();
  sendContactShareEmail.mockClear();
  getContactDecrypted.mockReset();
  getContactDecrypted.mockResolvedValue({ row: decrypted(), error: null });
});

describe("shareContactByEmail", () => {
  it("never mails another tenant's contact out", async () => {
    getContactDecrypted.mockResolvedValue({ row: decrypted({ user_id: VICTIM }), error: null });
    fake.seed("gmail_accounts", [
      { id: "acct-1", user_id: ATTACKER, email_address: "attacker@evil.test" },
    ]);
    await expect(
      call(shareContactByEmail, {
        data: { contactId: CONTACT_ID, toEmail: "attacker@evil.test" },
        context: asAttacker,
      }),
    ).rejects.toThrow("Contact not found");
    expect(
      sendContactShareEmail,
      "a cross-tenant share must never reach the Gmail sender",
    ).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("a failing decrypt aborts before any send", async () => {
    getContactDecrypted.mockResolvedValue({ row: null, error: "decrypt key missing" });
    await expect(
      call(shareContactByEmail, {
        data: { contactId: CONTACT_ID, toEmail: "friend@example.com" },
        context: asUser,
      }),
    ).rejects.toThrow("decrypt key missing");
    expect(sendContactShareEmail).not.toHaveBeenCalled();
  });

  it("sends the decrypted card from the caller's oldest Gmail account", async () => {
    fake.seed("gmail_accounts", [
      { id: "acct-1", user_id: TEST_USER, email_address: "me@self.io", created_at: "2026-01-01" },
    ]);
    const res = await call(shareContactByEmail, {
      data: { contactId: CONTACT_ID, toEmail: "friend@example.com", note: " hello " },
      context: asUser,
    });
    expect(res).toEqual({ ok: true });
    expect(sendContactShareEmail).toHaveBeenCalledWith({
      accountId: "acct-1",
      fromEmail: "me@self.io",
      toEmail: "friend@example.com",
      contact: {
        name: "Ada Lovelace",
        title: null,
        company: null,
        email: "ada@acme.com",
        phone: "+14155550100",
        website: null,
        linkedin: null,
        twitter: null,
        address_line1: "1 Analytical Way",
        address_line2: null,
        city: null,
        region: null,
        postal_code: null,
        country: null,
      },
      note: " hello ",
    });
    // The equality above is exact, which is the point: the contact's private
    // `notes` are decrypted in this handler but must never reach the card.
  });

  it("the gmail_accounts lookup is scoped to the caller", async () => {
    fake.seed("gmail_accounts", [
      { id: "acct-victim", user_id: VICTIM, email_address: "victim@example.com" },
    ]);
    await expect(
      call(shareContactByEmail, {
        data: { contactId: CONTACT_ID, toEmail: "friend@example.com" },
        context: asUser,
      }),
    ).rejects.toThrow("Connect your Gmail account");
    expect(sendContactShareEmail).not.toHaveBeenCalled();
    expect(fake.calls.selects[0]!.filters).toStrictEqual([
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
    ]);
  });

  it("zod rejects a non-uuid contact id, a bad recipient and an oversize note", async () => {
    await expect(
      shareContactByEmail({ data: { contactId: "nope", toEmail: "a@b.co" } }),
    ).rejects.toThrow();
    await expect(
      shareContactByEmail({ data: { contactId: CONTACT_ID, toEmail: "not-an-email" } }),
    ).rejects.toThrow();
    await expect(
      shareContactByEmail({
        data: { contactId: CONTACT_ID, toEmail: "a@b.co", note: "x".repeat(2001) },
      }),
    ).rejects.toThrow();
    expect(getContactDecrypted).not.toHaveBeenCalled();
  });
});

describe("listFoldersForPicker", () => {
  it("returns the folders ordered by priority then name", async () => {
    rls.seed("folders", [
      { id: "f1", user_id: TEST_USER, name: "Zeta", color: "#111111", priority: 5 },
      { id: "f2", user_id: TEST_USER, name: "Alpha", color: "#222222", priority: 9 },
    ]);
    const res = (await call(listFoldersForPicker, { data: {}, context: asUser })) as unknown as {
      folders: Array<{ id: string }>;
    };
    expect(res.folders.map((f) => f.id)).toStrictEqual(["f2", "f1"]);
  });

  it("a failing read surfaces to the caller", async () => {
    rls.onSelect("folders", () => ({ message: "statement timeout" }));
    await expect(call(listFoldersForPicker, { data: {}, context: asUser })).rejects.toThrow(
      "statement timeout",
    );
  });
});

describe("listUniqueInboxSenders", () => {
  beforeEach(() => {
    rls.seed("emails", [
      { id: "e1", user_id: TEST_USER, from_addr: "Ada@Acme.com", received_at: "2026-02-01" },
      { id: "e2", user_id: TEST_USER, from_addr: "ada@acme.com", received_at: "2026-02-05" },
      { id: "e3", user_id: TEST_USER, from_addr: "grace@navy.mil", received_at: "2026-02-02" },
      // Already a contact → excluded.
      { id: "e4", user_id: TEST_USER, from_addr: "known@acme.com", received_at: "2026-02-03" },
      // Machine sender → excluded by isLikelyHuman.
      { id: "e5", user_id: TEST_USER, from_addr: "noreply@acme.com", received_at: "2026-02-04" },
      // Another tenant's mail → filtered by the user_id predicate.
      { id: "e6", user_id: VICTIM, from_addr: "victim@evil.test", received_at: "2026-02-06" },
    ]);
    fake.seed("contacts", [
      makeContactRow({ id: "c1", user_id: TEST_USER, email: "known@acme.com" }),
    ]);
  });

  it("aggregates by address, skipping known contacts, robots and other tenants", async () => {
    const res = (await call(listUniqueInboxSenders, { data: {}, context: asUser })) as unknown as {
      senders: Array<{ email: string; count: number; lastReceivedAt: string | null }>;
    };
    expect(res.senders).toStrictEqual([
      { email: "ada@acme.com", name: null, count: 2, lastReceivedAt: "2026-02-05" },
      { email: "grace@navy.mil", name: null, count: 1, lastReceivedAt: "2026-02-02" },
    ]);
  });

  it("search narrows the list and limit caps it", async () => {
    const searched = (await call(listUniqueInboxSenders, {
      data: { search: "NAVY" },
      context: asUser,
    })) as unknown as { senders: Array<{ email: string }> };
    expect(searched.senders.map((s) => s.email)).toStrictEqual(["grace@navy.mil"]);

    const capped = (await call(listUniqueInboxSenders, {
      data: { limit: 1 },
      context: asUser,
    })) as unknown as { senders: Array<{ email: string }> };
    expect(capped.senders.map((s) => s.email)).toStrictEqual(["ada@acme.com"]);
  });

  it("a folder filter is pushed down to the query", async () => {
    const folderId = "22222222-2222-4222-8222-222222222222";
    await call(listUniqueInboxSenders, { data: { folderIds: [folderId] }, context: asUser });
    expect(rls.calls.selects[0]!.filters).toContainEqual({
      op: "in",
      col: "folder_id",
      value: [folderId],
      extra: undefined,
    });
  });

  it("a failing emails read surfaces to the caller", async () => {
    rls.onSelect("emails", () => ({ message: "statement timeout" }));
    await expect(call(listUniqueInboxSenders, { data: {}, context: asUser })).rejects.toThrow(
      "statement timeout",
    );
  });
});
