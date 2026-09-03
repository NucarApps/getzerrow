// Authorised-path contract for /api/mobile/gmail-connect — where the Swift
// app hands over the Google tokens it obtained on device, and where it reads
// back how the user's mail is categorized.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import {
  MOBILE_USER,
  jsonBody,
  mobileRequest,
  mockMobileAuth,
  serverHandler,
} from "@/lib/__fixtures__/mobile-route-harness";
import type { CategorizationRule } from "@/lib/mobile-gmail.server";
import * as connectRoute from "./gmail-connect";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));
vi.mock("@/lib/mobile-auth.server", () => mockMobileAuth(() => fake));

const gmail = vi.hoisted(() => ({
  connectGmailCore: vi.fn<typeof import("@/lib/mobile-gmail.server").connectGmailCore>(),
  getCategorizationRules:
    vi.fn<typeof import("@/lib/mobile-gmail.server").getCategorizationRules>(),
}));
vi.mock("@/lib/mobile-gmail.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mobile-gmail.server")>()),
  ...gmail,
}));

const GET = serverHandler(connectRoute, "GET");
const POST = serverHandler(connectRoute, "POST");

const ACCOUNT = "aaaaaaaa-0000-4000-8000-000000000001";

const RULE: CategorizationRule = {
  id: "f-1",
  name: "Newsletters",
  color: "#123456",
  priority: 3,
  gmail_label_id: "Label_1",
  ai_rule: null,
  filter_logic: "AND",
  filter_tree: null,
  auto_archive: true,
  auto_mark_read: false,
  auto_star: false,
  hide_from_inbox: true,
  skip_ai: false,
  min_ai_confidence: 0.7,
  snooze_hours: null,
  forward_to: null,
  filters: [{ field: "from", op: "contains", value: "@news.test" }],
};

function get() {
  return GET(mobileRequest("/api/mobile/gmail-connect", { method: "GET" }));
}
function post(body: unknown) {
  return POST(mobileRequest("/api/mobile/gmail-connect", { body }));
}

beforeEach(() => {
  fake.reset();
  gmail.getCategorizationRules.mockResolvedValue([]);
  gmail.connectGmailCore.mockResolvedValue({
    account_id: ACCOUNT,
    email_address: "me@work.test",
  });
});

describe("GET /api/mobile/gmail-connect", () => {
  it("returns the caller's categorization rules verbatim", async () => {
    gmail.getCategorizationRules.mockResolvedValue([RULE]);
    expect(await jsonBody(await get(), 200)).toStrictEqual({ rules: [RULE] });
    expect(gmail.getCategorizationRules).toHaveBeenCalledWith(MOBILE_USER);
  });

  it("reports a rules-load failure as 500 with the message", async () => {
    gmail.getCategorizationRules.mockRejectedValue(new Error("folders unavailable"));
    expect(await jsonBody(await get(), 500)).toStrictEqual({
      ok: false,
      error: "folders unavailable",
    });
  });

  it("falls back to a generic message when the failure is not an Error", async () => {
    gmail.getCategorizationRules.mockRejectedValue("boom");
    expect(await jsonBody(await get(), 500)).toStrictEqual({
      ok: false,
      error: "Failed to load rules",
    });
  });
});

describe("POST /api/mobile/gmail-connect", () => {
  it("connects with an on-device token pair and returns the account plus rules", async () => {
    gmail.getCategorizationRules.mockResolvedValue([RULE]);
    const res = await post({
      email_address: "me@work.test",
      access_token: "ya29.access",
      refresh_token: "1//refresh",
      expires_in: 3599,
    });

    expect(await jsonBody(res, 200)).toStrictEqual({
      ok: true,
      account_id: ACCOUNT,
      email_address: "me@work.test",
      rules: [RULE],
    });
    expect(gmail.connectGmailCore).toHaveBeenCalledWith(MOBILE_USER, {
      email_address: "me@work.test",
      access_token: "ya29.access",
      refresh_token: "1//refresh",
      expires_in: 3599,
    });
  });

  it("connects with a server auth code alone", async () => {
    const res = await post({ server_auth_code: "4/code" });
    expect(await jsonBody<{ ok: boolean }>(res, 200)).toMatchObject({ ok: true });
    expect(gmail.connectGmailCore).toHaveBeenCalledWith(MOBILE_USER, {
      server_auth_code: "4/code",
    });
  });

  it.each([
    ["neither a code nor tokens", {}],
    ["an access token with no refresh token", { access_token: "ya29.access" }],
    ["a refresh token with no access token", { refresh_token: "1//refresh" }],
    [
      "an expiry beyond 24h",
      { access_token: "a", refresh_token: "r", expires_in: 60 * 60 * 24 + 1 },
    ],
    ["a non-positive expiry", { access_token: "a", refresh_token: "r", expires_in: 0 }],
    ["a malformed email address", { server_auth_code: "4/code", email_address: "nope" }],
    ["an empty access token", { access_token: "", refresh_token: "r" }],
  ])("refuses %s with 400 and never touches Google", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid connect payload");
    expect(gmail.connectGmailCore).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const res = await POST(mobileRequest("/api/mobile/gmail-connect", { rawBody: "[" }));
    expect(res.status).toBe(400);
    expect(gmail.connectGmailCore).not.toHaveBeenCalled();
  });

  it("reports a connect failure as 400 with the message and loads no rules", async () => {
    gmail.connectGmailCore.mockRejectedValue(new Error("invalid_grant"));
    expect(await jsonBody(await post({ server_auth_code: "4/code" }), 400)).toStrictEqual({
      ok: false,
      error: "invalid_grant",
    });
    expect(gmail.getCategorizationRules).not.toHaveBeenCalled();
  });

  it("falls back to a generic message when the failure is not an Error", async () => {
    gmail.connectGmailCore.mockRejectedValue({ code: 500 });
    expect(await jsonBody(await post({ server_auth_code: "4/code" }), 400)).toStrictEqual({
      ok: false,
      error: "Failed to connect Gmail",
    });
  });
});
