// Unit tests for the meeting event-capture preferences
// (src/lib/meetings/event-prefs.functions.ts). These decide which calendar
// events the notetaker ignores, so the contracts are the defaults a user
// with no stored row gets, the enum validation, the dedupe, and that the
// upsert is keyed on the caller's own user id.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { callWithRlsClient } from "@/lib/__fixtures__/rls-server-fn";
import { DEFAULT_HIDDEN_TYPES } from "../meetings-helpers.server";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));

import { getMeetingEventPrefs, updateMeetingEventPrefs } from "./event-prefs.functions";

const call = <F extends (args: never) => Promise<unknown>>(fn: F) =>
  callWithRlsClient(fn, { fake });

beforeEach(() => {
  fake.reset();
});

describe("getMeetingEventPrefs", () => {
  it("falls back to the shipped defaults when nothing is stored", async () => {
    await expect(call(getMeetingEventPrefs)()).resolves.toStrictEqual({
      hiddenEventTypes: DEFAULT_HIDDEN_TYPES,
      colorSkip: [],
    });
    expect(writeCount(fake)).toBe(0);
  });

  it("returns the caller's stored preferences, including an explicit empty list", async () => {
    fake.seed("meeting_bot_settings", [
      { user_id: TEST_USER, hidden_event_types: [], event_color_skip: ["4"] },
      { user_id: "someone-else", hidden_event_types: ["outOfOffice"], event_color_skip: ["1"] },
    ]);

    await expect(call(getMeetingEventPrefs)()).resolves.toStrictEqual({
      hiddenEventTypes: [],
      colorSkip: ["4"],
    });
  });

  it("surfaces a failing read", async () => {
    fake.onSelect("meeting_bot_settings", () => ({ message: "read denied" }));

    await expect(call(getMeetingEventPrefs)()).rejects.toThrow("read denied");
  });
});

describe("updateMeetingEventPrefs", () => {
  it("dedupes both lists and keys the upsert on the caller", async () => {
    await expect(
      call(updateMeetingEventPrefs)({
        data: {
          hiddenEventTypes: ["outOfOffice", "outOfOffice", "focusTime"],
          colorSkip: ["4", "4"],
        },
      }),
    ).resolves.toStrictEqual({ ok: true });

    expect(fake.calls.upserts.map((w) => [w.table, w.payload, w.options])).toStrictEqual([
      [
        "meeting_bot_settings",
        {
          user_id: TEST_USER,
          hidden_event_types: ["outOfOffice", "focusTime"],
          event_color_skip: ["4"],
        },
        { onConflict: "user_id" },
      ],
    ]);
  });

  it("stores empty lists when the user opts to capture everything", async () => {
    await call(updateMeetingEventPrefs)({ data: { hiddenEventTypes: [], colorSkip: [] } });

    expect(fake.calls.upserts[0]?.payload).toStrictEqual({
      user_id: TEST_USER,
      hidden_event_types: [],
      event_color_skip: [],
    });
  });

  it("rejects an event type or colour outside the known sets", async () => {
    await expect(
      call(updateMeetingEventPrefs)({
        data: { hiddenEventTypes: ["notAType"], colorSkip: [] },
      }),
    ).rejects.toThrow();
    await expect(
      call(updateMeetingEventPrefs)({
        data: { hiddenEventTypes: [], colorSkip: ["99"] },
      }),
    ).rejects.toThrow();
    expect(writeCount(fake)).toBe(0);
  });

  it("surfaces a rejected upsert", async () => {
    fake.onUpsert("meeting_bot_settings", () => ({ message: "upsert denied" }));

    await expect(
      call(updateMeetingEventPrefs)({ data: { hiddenEventTypes: [], colorSkip: [] } }),
    ).rejects.toThrow("upsert denied");
  });
});
