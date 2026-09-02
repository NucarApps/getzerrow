// Unit tests for the meeting-bot customization
// (src/lib/meetings/bot-settings.functions.ts). Contracts pinned: the
// defaults an unconfigured user sees, the tri-state avatar handling
// (untouched / stamped / cleared, with the stored object removed from the
// caller's own storage prefix), and the validation bounds on the auto-leave
// timer that ends up in the Recall bot config.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { DEFAULT_CHAT_MESSAGE } from "../meetings-helpers.server";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));

import { getMeetingBotSettings, updateMeetingBotSettings } from "./bot-settings.functions";

const NOW_ISO = "2026-03-01T12:00:00.000Z";

const storageRemove = vi.fn(async (_paths: string[]) => ({ data: null, error: null }));
const storageFrom = vi.fn((_bucket: string) => ({ remove: storageRemove }));

/** The RLS client these handlers see, plus the storage surface they use. */
function rlsContext() {
  return { userId: TEST_USER, supabase: { ...fake.client, storage: { from: storageFrom } } };
}

const call = <F extends (args: never) => Promise<unknown>>(fn: F) => {
  const stubbed = fn as unknown as (args?: {
    data?: unknown;
    context?: Record<string, unknown>;
  }) => Promise<Awaited<ReturnType<F>>>;
  return (args?: { data?: unknown }) => stubbed({ ...args, context: rlsContext() });
};

const VALID = {
  botName: "  Scribe  ",
  chatMessage: "  recording started  ",
  chatResendOnJoin: true,
  autoLeaveEnabled: true,
  autoLeaveMinutes: 30,
};

beforeEach(() => {
  fake.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getMeetingBotSettings", () => {
  it("returns the shipped defaults for a user who has never configured a bot", async () => {
    await expect(call(getMeetingBotSettings)()).resolves.toStrictEqual({
      botName: "Atzro Notetaker",
      chatMessage: DEFAULT_CHAT_MESSAGE,
      chatResendOnJoin: true,
      hasAvatar: false,
      autoLeaveEnabled: true,
      autoLeaveMinutes: 30,
    });
    expect(writeCount(fake)).toBe(0);
  });

  it("returns the caller's stored settings and reports the avatar as present", async () => {
    fake.seed("meeting_bot_settings", [
      {
        user_id: TEST_USER,
        bot_name: "Scribe",
        chat_message: "",
        chat_resend_on_join: false,
        avatar_updated_at: "2026-02-01T00:00:00Z",
        auto_leave_enabled: false,
        auto_leave_minutes: 15,
      },
    ]);

    await expect(call(getMeetingBotSettings)()).resolves.toStrictEqual({
      botName: "Scribe",
      chatMessage: "",
      chatResendOnJoin: false,
      hasAvatar: true,
      autoLeaveEnabled: false,
      autoLeaveMinutes: 15,
    });
  });

  it("surfaces a failing read", async () => {
    fake.onSelect("meeting_bot_settings", () => ({ message: "read denied" }));

    await expect(call(getMeetingBotSettings)()).rejects.toThrow("read denied");
  });
});

describe("updateMeetingBotSettings", () => {
  it("trims the text fields and leaves an existing avatar alone", async () => {
    await expect(call(updateMeetingBotSettings)({ data: VALID })).resolves.toStrictEqual({
      ok: true,
    });

    expect(fake.calls.upserts.map((w) => [w.table, w.payload, w.options])).toStrictEqual([
      [
        "meeting_bot_settings",
        {
          user_id: TEST_USER,
          bot_name: "Scribe",
          chat_message: "recording started",
          chat_resend_on_join: true,
          auto_leave_enabled: true,
          auto_leave_minutes: 30,
        },
        { onConflict: "user_id" },
      ],
    ]);
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it("stamps the avatar time when a new picture was just uploaded", async () => {
    await call(updateMeetingBotSettings)({ data: { ...VALID, avatar: "set" } });

    expect(fake.calls.upserts[0]?.payload).toMatchObject({ avatar_updated_at: NOW_ISO });
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it("removes the stored object from the caller's own prefix when clearing", async () => {
    await call(updateMeetingBotSettings)({ data: { ...VALID, avatar: "clear" } });

    expect(storageFrom.mock.calls).toStrictEqual([["meeting-bot-avatars"]]);
    expect(storageRemove.mock.calls).toStrictEqual([[[`${TEST_USER}/avatar.jpg`]]]);
    expect(fake.calls.upserts[0]?.payload).toMatchObject({ avatar_updated_at: null });
  });

  it("rejects an empty bot name and an out-of-range auto-leave timer", async () => {
    await expect(
      call(updateMeetingBotSettings)({ data: { ...VALID, botName: "   " } }),
    ).rejects.toThrow();
    await expect(
      call(updateMeetingBotSettings)({ data: { ...VALID, autoLeaveMinutes: 4 } }),
    ).rejects.toThrow();
    await expect(
      call(updateMeetingBotSettings)({ data: { ...VALID, autoLeaveMinutes: 241 } }),
    ).rejects.toThrow();
    expect(writeCount(fake)).toBe(0);
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it("surfaces a rejected upsert", async () => {
    fake.onUpsert("meeting_bot_settings", () => ({ message: "upsert denied" }));

    await expect(call(updateMeetingBotSettings)({ data: VALID })).rejects.toThrow("upsert denied");
  });
});
