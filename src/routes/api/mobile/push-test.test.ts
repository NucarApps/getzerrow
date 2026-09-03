// Authorised-path contract for POST /api/mobile/push-test — the button the
// iOS app offers to confirm push wiring end to end.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import {
  MOBILE_USER,
  jsonBody,
  mobileRequest,
  mockMobileAuth,
  serverHandler,
} from "@/lib/__fixtures__/mobile-route-harness";
import * as pushRoute from "./push-test";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));
vi.mock("@/lib/mobile-auth.server", () => mockMobileAuth(() => fake));

const sendPushToUser = vi.hoisted(() => vi.fn<typeof import("@/lib/push.server").sendPushToUser>());
vi.mock("@/lib/push.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/push.server")>()),
  sendPushToUser,
}));

const POST = serverHandler(pushRoute, "POST");

function post() {
  return POST(mobileRequest("/api/mobile/push-test", { body: {} }));
}

beforeEach(() => {
  fake.reset();
  sendPushToUser.mockResolvedValue(undefined);
});

describe("POST /api/mobile/push-test", () => {
  it("pushes the fixed test notification to the caller's own devices", async () => {
    expect(await jsonBody(await post(), 200)).toStrictEqual({ ok: true });
    expect(sendPushToUser).toHaveBeenCalledWith(MOBILE_USER, {
      title: "Atzro",
      body: "Push notifications are working.",
      data: { type: "test" },
    });
  });

  it("ignores the request body — there is nothing for a caller to choose", async () => {
    await POST(
      mobileRequest("/api/mobile/push-test", {
        body: { title: "Pay this invoice", body: "http://phish.test" },
      }),
    );
    expect(sendPushToUser).toHaveBeenCalledWith(MOBILE_USER, {
      title: "Atzro",
      body: "Push notifications are working.",
      data: { type: "test" },
    });
  });

  it("lets a send failure propagate — the route wraps nothing", async () => {
    // Documented, not endorsed: unlike its siblings this handler has no
    // try/catch, so a push transport failure surfaces as a rejected handler
    // (a framework 500) rather than a JSON { ok: false } body.
    sendPushToUser.mockRejectedValue(new Error("expo unreachable"));
    await expect(post()).rejects.toThrow("expo unreachable");
  });
});
