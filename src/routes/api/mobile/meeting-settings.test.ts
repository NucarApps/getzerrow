// Authorised-path contract for /api/mobile/meeting-settings — the notetaker
// bot's name and chat message as the iOS app reads and saves them.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import {
  MOBILE_USER,
  jsonBody,
  mobileRequest,
  mockMobileAuth,
  serverHandler,
} from "@/lib/__fixtures__/mobile-route-harness";
import * as settingsRoute from "./meeting-settings";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));
vi.mock("@/lib/mobile-auth.server", () => mockMobileAuth(() => fake));

const GET = serverHandler(settingsRoute, "GET");
const POST = serverHandler(settingsRoute, "POST");

const DEFAULTS = {
  botName: "Atzro Notetaker",
  chatMessage: "Hi, I'm the Atzro notetaker and I'll be taking notes for this meeting.",
  chatResendOnJoin: true,
  hasAvatar: false,
};

function get() {
  return GET(mobileRequest("/api/mobile/meeting-settings", { method: "GET" }));
}
function post(body: unknown) {
  return POST(mobileRequest("/api/mobile/meeting-settings", { body }));
}

beforeEach(() => {
  fake.reset();
});

describe("GET /api/mobile/meeting-settings", () => {
  it("hands back the product defaults when the user has saved nothing", async () => {
    fake.seed("meeting_bot_settings", []);
    expect(await jsonBody(await get(), 200)).toStrictEqual({ settings: DEFAULTS });
    expect(fake.calls.selects[0]?.filters).toStrictEqual([
      { op: "eq", col: "user_id", value: MOBILE_USER, extra: undefined },
    ]);
  });

  it("returns the saved settings and reports a stored avatar", async () => {
    fake.seed("meeting_bot_settings", [
      {
        user_id: MOBILE_USER,
        bot_name: "Scribe",
        chat_message: "Recording for the team.",
        chat_resend_on_join: false,
        avatar_updated_at: "2026-08-01T00:00:00.000Z",
      },
    ]);
    expect(await jsonBody(await get(), 200)).toStrictEqual({
      settings: {
        botName: "Scribe",
        chatMessage: "Recording for the team.",
        chatResendOnJoin: false,
        hasAvatar: true,
      },
    });
  });

  it("falls back per field when a saved column is null", async () => {
    fake.seed("meeting_bot_settings", [
      {
        user_id: MOBILE_USER,
        bot_name: null,
        chat_message: null,
        chat_resend_on_join: null,
        avatar_updated_at: null,
      },
    ]);
    expect(await jsonBody(await get(), 200)).toStrictEqual({ settings: DEFAULTS });
  });

  it("treats an empty saved chat message as a real (empty) choice, not a default", async () => {
    fake.seed("meeting_bot_settings", [
      { user_id: MOBILE_USER, bot_name: "Scribe", chat_message: "", chat_resend_on_join: true },
    ]);
    const body = await jsonBody<{ settings: { chatMessage: string } }>(await get(), 200);
    expect(body.settings.chatMessage).toBe("");
  });
});

describe("POST /api/mobile/meeting-settings", () => {
  it("upserts the trimmed settings on user_id", async () => {
    const res = await post({
      botName: "  Scribe  ",
      chatMessage: "  Recording for the team.  ",
      chatResendOnJoin: false,
    });
    expect(await jsonBody(res, 200)).toStrictEqual({ ok: true });
    expect(fake.calls.upserts).toHaveLength(1);
    expect(fake.calls.upserts[0]?.table).toBe("meeting_bot_settings");
    expect(fake.calls.upserts[0]?.payload).toStrictEqual({
      user_id: MOBILE_USER,
      bot_name: "Scribe",
      chat_message: "Recording for the team.",
      chat_resend_on_join: false,
    });
    expect(fake.calls.upserts[0]?.options).toStrictEqual({ onConflict: "user_id" });
  });

  it("accepts an empty chat message (the user opting out of the join note)", async () => {
    const res = await post({ botName: "Scribe", chatMessage: "", chatResendOnJoin: true });
    expect(await jsonBody(res, 200)).toStrictEqual({ ok: true });
    expect(fake.calls.upserts[0]?.payload).toMatchObject({ chat_message: "" });
  });

  it.each([
    ["a blank bot name", { botName: "   ", chatMessage: "", chatResendOnJoin: true }],
    ["a missing flag", { botName: "Scribe", chatMessage: "" }],
    ["a non-boolean flag", { botName: "Scribe", chatMessage: "", chatResendOnJoin: "yes" }],
    [
      "an over-long chat message",
      { botName: "Scribe", chatMessage: "x".repeat(1001), chatResendOnJoin: true },
    ],
    [
      "an over-long bot name",
      { botName: "n".repeat(101), chatMessage: "", chatResendOnJoin: true },
    ],
  ])("refuses %s with 400 and writes nothing", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid settings");
    expect(writeCount(fake)).toBe(0);
  });

  it("refuses a body that is not JSON", async () => {
    const res = await POST(mobileRequest("/api/mobile/meeting-settings", { rawBody: "oops" }));
    expect(res.status).toBe(400);
    expect(writeCount(fake)).toBe(0);
  });

  it("surfaces an upsert failure as 400 with the message", async () => {
    fake.onUpsert("meeting_bot_settings", () => ({ message: "settings write denied" }));
    const res = await post({ botName: "Scribe", chatMessage: "", chatResendOnJoin: true });
    expect(await jsonBody(res, 400)).toStrictEqual({
      ok: false,
      error: "settings write denied",
    });
  });
});
