// Authorised-path contract for POST /api/mobile/emails/feed — the decrypted
// mail feed the iOS app renders.
//
// The decrypt readers are left REAL and driven through the Supabase fake's
// RPC handlers, so the arguments the route hands `get_emails_list_decrypted`
// (scope, folder, cursor, limit) are asserted rather than assumed, and the
// row shape the app consumes is the one the RPC actually returns.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import {
  MOBILE_USER,
  OTHER_USER,
  jsonBody,
  mobileRequest,
  mockMobileAuth,
  serverHandler,
} from "@/lib/__fixtures__/mobile-route-harness";
import type { DecryptedEmail, EmailListRow } from "@/lib/sync/encrypted-reader";
import * as feedRoute from "./emails.feed";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));
vi.mock("@/lib/mobile-auth.server", () => mockMobileAuth(() => fake));

const POST = serverHandler(feedRoute, "POST");

const ACCOUNT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ACCOUNT_B = "aaaaaaaa-0000-4000-8000-000000000002";
const FOLDER = "ffffffff-0000-4000-8000-000000000001";
const EMAIL_ID = "eeeeeeee-0000-4000-8000-000000000001";
const FOREIGN_EMAIL = "eeeeeeee-0000-4000-8000-0000000000ff";

function post(body: unknown) {
  return POST(mobileRequest("/api/mobile/emails/feed", { body }));
}

function listRow(over: Partial<EmailListRow> = {}): EmailListRow {
  return {
    id: EMAIL_ID,
    from_addr: "sender@example.test",
    from_name: "Sender",
    subject: "Quarterly numbers",
    snippet: "Attached…",
    to_addrs: "me@work.test",
    ai_summary: "Numbers are up",
    classification_reason: "matched rule",
    received_at: "2026-09-02T10:00:00.000Z",
    is_read: false,
    is_archived: false,
    folder_id: FOLDER,
    ai_confidence: 0.9,
    thread_id: "t-1",
    classified_by: "rule",
    matched_filter_ids: ["r-1"],
    matched_folder_ids: [FOLDER],
    has_attachment: true,
    processed_at: "2026-09-02T10:00:01.000Z",
    raw_labels: ["INBOX"],
    snoozed_until: null,
    gmail_message_id: "m-1",
    surfaced_to_inbox: true,
    origin_addr: null,
    reply_to_addr: null,
    is_forwarded: false,
    ...over,
  };
}

function detailRow(over: Partial<DecryptedEmail> = {}): DecryptedEmail {
  return {
    id: EMAIL_ID,
    user_id: MOBILE_USER,
    gmail_account_id: ACCOUNT_A,
    gmail_message_id: "m-1",
    thread_id: "t-1",
    from_addr: "sender@example.test",
    from_name: "Sender",
    to_addrs: "me@work.test",
    cc: null,
    subject: "Quarterly numbers",
    snippet: "Attached…",
    body_text: "the plaintext body",
    body_html: "<p>the plaintext body</p>",
    ai_summary: null,
    classification_reason: null,
    classified_by: null,
    ai_confidence: null,
    received_at: "2026-09-02T10:00:00.000Z",
    is_read: false,
    is_archived: false,
    has_attachment: false,
    raw_labels: ["INBOX"],
    folder_id: FOLDER,
    matched_filter_ids: [],
    matched_folder_ids: [],
    snoozed_until: null,
    forwarded_to: null,
    forwarded_at: null,
    list_id: null,
    in_reply_to: null,
    published_at_ms: null,
    processed_at: null,
    created_at: "2026-09-02T10:00:02.000Z",
    ...over,
  };
}

/** The caller's two inboxes, plus another tenant's that the user_id filter
 * must exclude. */
function seedAccounts() {
  fake.seed("gmail_accounts", [
    { id: ACCOUNT_A, user_id: MOBILE_USER },
    { id: ACCOUNT_B, user_id: MOBILE_USER },
    { id: "aaaaaaaa-0000-4000-8000-0000000000ff", user_id: OTHER_USER },
  ]);
}

beforeEach(() => {
  fake.reset();
  vi.stubEnv("EMAIL_ENC_KEY", "test-enc-key");
});

describe("POST /api/mobile/emails/feed — request validation", () => {
  it("refuses a body that is not JSON", async () => {
    const res = await POST(mobileRequest("/api/mobile/emails/feed", { rawBody: "nope" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid request body");
    expect(fake.calls.rpcs).toEqual([]);
  });

  it("refuses an unknown kind", async () => {
    const res = await post({ kind: "search" });
    expect(res.status).toBe(400);
    expect(fake.calls.rpcs).toEqual([]);
  });

  it("refuses a scope outside all/all_mail/no_rules/folder", async () => {
    const res = await post({ kind: "list", scope: "everything" });
    expect(res.status).toBe(400);
    expect(fake.calls.selects).toEqual([]);
  });

  it("refuses a detail request whose email_id is not a uuid", async () => {
    const res = await post({ kind: "detail", email_id: "1" });
    expect(res.status).toBe(400);
    expect(fake.calls.rpcs).toEqual([]);
  });
});

describe("kind:list", () => {
  beforeEach(seedAccounts);

  it("reads only the caller's inboxes and asks each for the default page", async () => {
    fake.onRpc("get_emails_list_decrypted", () => ({ data: [] }));

    const res = await post({ kind: "list" });
    expect(await jsonBody(res, 200)).toStrictEqual({ ok: true, emails: [] });

    expect(fake.calls.selects).toHaveLength(1);
    expect(fake.calls.selects[0]).toMatchObject({
      table: "gmail_accounts",
      columns: "id",
      filters: [{ op: "eq", col: "user_id", value: MOBILE_USER, extra: undefined }],
    });
    expect(fake.calls.rpcs.map((r) => r.args)).toStrictEqual([
      {
        p_account_id: ACCOUNT_A,
        p_user_id: MOBILE_USER,
        p_scope: "all",
        p_folder_id: null,
        p_cursor: null,
        p_limit: 300,
        p_key: "test-enc-key",
      },
      {
        p_account_id: ACCOUNT_B,
        p_user_id: MOBILE_USER,
        p_scope: "all",
        p_folder_id: null,
        p_cursor: null,
        p_limit: 300,
        p_key: "test-enc-key",
      },
    ]);
  });

  it("returns the decrypted list row verbatim, newest first across inboxes", async () => {
    const older = listRow({ id: "e-old", received_at: "2026-09-01T08:00:00.000Z" });
    const newer = listRow({ id: "e-new", received_at: "2026-09-02T10:00:00.000Z" });
    fake.onRpc("get_emails_list_decrypted", (args) => ({
      data: args.p_account_id === ACCOUNT_A ? [older] : [newer],
    }));

    const body = await jsonBody<{ ok: boolean; emails: EmailListRow[] }>(
      await post({ kind: "list" }),
      200,
    );
    expect(body.ok).toBe(true);
    expect(body.emails.map((e) => e.id)).toStrictEqual(["e-new", "e-old"]);
    // Every column the app reads survives the merge untouched.
    expect(body.emails[1]).toStrictEqual(older);
  });

  it("sorts a row with no received_at last rather than dropping it", async () => {
    fake.onRpc("get_emails_list_decrypted", (args) =>
      args.p_account_id === ACCOUNT_A
        ? { data: [listRow({ id: "undated", received_at: null })] }
        : { data: [listRow({ id: "dated", received_at: "2026-01-01T00:00:00.000Z" })] },
    );
    const body = await jsonBody<{ emails: EmailListRow[] }>(await post({ kind: "list" }), 200);
    expect(body.emails.map((e) => e.id)).toStrictEqual(["dated", "undated"]);
  });

  it("caps the merged result at the requested limit", async () => {
    fake.onRpc("get_emails_list_decrypted", (args) => ({
      data: [
        listRow({ id: `${String(args.p_account_id)}-1`, received_at: "2026-09-02T10:00:00.000Z" }),
        listRow({ id: `${String(args.p_account_id)}-2`, received_at: "2026-09-01T10:00:00.000Z" }),
      ],
    }));
    const body = await jsonBody<{ emails: EmailListRow[] }>(
      await post({ kind: "list", limit: 3 }),
      200,
    );
    // Four rows came back from two inboxes; the app asked for three.
    expect(body.emails).toHaveLength(3);
    expect(fake.calls.rpcs.every((r) => r.args.p_limit === 3)).toBe(true);
  });

  it("refuses a limit above the 500 cap rather than silently clamping it", async () => {
    const res = await post({ kind: "list", limit: 501 });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid request body");
    expect(fake.calls.rpcs).toEqual([]);
  });

  it("accepts the 500 boundary and refuses 0", async () => {
    fake.onRpc("get_emails_list_decrypted", () => ({ data: [] }));
    expect((await post({ kind: "list", limit: 500 })).status).toBe(200);
    expect(fake.calls.rpcs[0]?.args.p_limit).toBe(500);
    expect((await post({ kind: "list", limit: 0 })).status).toBe(400);
  });

  it("refuses a fractional limit", async () => {
    expect((await post({ kind: "list", limit: 2.5 })).status).toBe(400);
  });

  it("passes the cursor and folder through for a folder-scoped page", async () => {
    fake.onRpc("get_emails_list_decrypted", () => ({ data: [] }));
    await post({
      kind: "list",
      scope: "folder",
      folder_id: FOLDER,
      cursor: "2026-09-01T00:00:00.000Z",
      limit: 50,
    });
    expect(fake.calls.rpcs[0]?.args).toMatchObject({
      p_scope: "folder",
      p_folder_id: FOLDER,
      p_cursor: "2026-09-01T00:00:00.000Z",
      p_limit: 50,
    });
  });

  it.each(["all", "all_mail", "no_rules", "folder"] as const)(
    "forwards the %s scope unchanged",
    async (scope) => {
      fake.onRpc("get_emails_list_decrypted", () => ({ data: [] }));
      await post({ kind: "list", scope });
      expect(fake.calls.rpcs[0]?.args.p_scope).toBe(scope);
    },
  );

  it("returns an empty feed when the caller has no inbox connected", async () => {
    fake.seed("gmail_accounts", []);
    expect(await jsonBody(await post({ kind: "list" }), 200)).toStrictEqual({
      ok: true,
      emails: [],
    });
    expect(fake.calls.rpcs).toEqual([]);
  });

  it("reports a failed account read as 500 without listing mail", async () => {
    fake.onSelect("gmail_accounts", () => ({ message: "accounts unavailable" }));
    expect(await jsonBody(await post({ kind: "list" }), 500)).toStrictEqual({
      ok: false,
      error: "accounts unavailable",
    });
    expect(fake.calls.rpcs).toEqual([]);
  });

  it("reports a failed decrypt as 500", async () => {
    fake.onRpc("get_emails_list_decrypted", () => ({ error: { message: "bad key" } }));
    expect(await jsonBody(await post({ kind: "list" }), 500)).toStrictEqual({
      ok: false,
      error: "bad key",
    });
  });

  it("never writes", async () => {
    fake.onRpc("get_emails_list_decrypted", () => ({ data: [listRow()] }));
    await post({ kind: "list" });
    expect(writeCount(fake)).toBe(0);
  });
});

describe("kind:detail", () => {
  it("returns the caller's own decrypted message, body included", async () => {
    const row = detailRow();
    fake.onRpc("get_emails_decrypted", () => ({ data: [row] }));

    const res = await post({ kind: "detail", email_id: EMAIL_ID });
    expect(await jsonBody(res, 200)).toStrictEqual({ ok: true, email: row });
    expect(fake.calls.rpcs).toStrictEqual([
      { fn: "get_emails_decrypted", args: { p_ids: [EMAIL_ID], p_key: "test-enc-key" } },
    ]);
  });

  it("refuses another tenant's message with a bare 404 that leaks no content", async () => {
    fake.onRpc("get_emails_decrypted", () => ({
      data: [
        detailRow({
          id: FOREIGN_EMAIL,
          user_id: OTHER_USER,
          subject: "Series B term sheet",
          body_text: "confidential",
        }),
      ],
    }));

    const res = await post({ kind: "detail", email_id: FOREIGN_EMAIL });
    const text = await res.text();
    expect(res.status).toBe(404);
    expect(JSON.parse(text)).toStrictEqual({ ok: false, error: "Email not found" });
    expect(text).not.toContain("Series B");
    expect(text).not.toContain("confidential");
  });

  it("returns 404 for an id that decrypts to nothing", async () => {
    fake.onRpc("get_emails_decrypted", () => ({ data: [] }));
    expect(await jsonBody(await post({ kind: "detail", email_id: EMAIL_ID }), 404)).toStrictEqual({
      ok: false,
      error: "Email not found",
    });
  });

  it("reports a failed decrypt as 500", async () => {
    fake.onRpc("get_emails_decrypted", () => ({ error: { message: "decrypt failed" } }));
    expect(await jsonBody(await post({ kind: "detail", email_id: EMAIL_ID }), 500)).toStrictEqual({
      ok: false,
      error: "decrypt failed",
    });
  });
});
