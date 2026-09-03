// Authorised-path contract for POST /api/mobile/emails/action — archive,
// read/unread and move from the iOS message list.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import {
  MOBILE_USER,
  jsonBody,
  mobileRequest,
  mockMobileAuth,
  serverHandler,
} from "@/lib/__fixtures__/mobile-route-harness";
import * as actionRoute from "./emails.action";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));
vi.mock("@/lib/mobile-auth.server", () => mockMobileAuth(() => fake));

const actions = vi.hoisted(() => ({
  archiveEmailCore: vi.fn<typeof import("@/lib/mobile-actions.server").archiveEmailCore>(),
  markEmailReadCore: vi.fn<typeof import("@/lib/mobile-actions.server").markEmailReadCore>(),
  moveEmailCore: vi.fn<typeof import("@/lib/mobile-actions.server").moveEmailCore>(),
}));
vi.mock("@/lib/mobile-actions.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mobile-actions.server")>()),
  ...actions,
}));

const POST = serverHandler(actionRoute, "POST");

const EMAIL_ID = "eeeeeeee-0000-4000-8000-000000000001";
const FOLDER_ID = "ffffffff-0000-4000-8000-000000000001";

function post(body: unknown) {
  return POST(mobileRequest("/api/mobile/emails/action", { body }));
}

function noCoreCalled() {
  return [actions.archiveEmailCore, actions.markEmailReadCore, actions.moveEmailCore].every(
    (fn) => fn.mock.calls.length === 0,
  );
}

beforeEach(() => {
  fake.reset();
  actions.archiveEmailCore.mockResolvedValue({ ok: true });
  actions.markEmailReadCore.mockResolvedValue({ ok: true });
  actions.moveEmailCore.mockResolvedValue({ ok: true });
});

describe("POST /api/mobile/emails/action", () => {
  it("archives through the shared core, scoped to the caller", async () => {
    const res = await post({ action: "archive", email_id: EMAIL_ID });
    expect(await jsonBody(res, 200)).toStrictEqual({ ok: true });
    expect(actions.archiveEmailCore).toHaveBeenCalledWith(MOBILE_USER, EMAIL_ID);
  });

  it("marks read and unread through the same core with the flag flipped", async () => {
    expect(
      await jsonBody(await post({ action: "mark_read", email_id: EMAIL_ID }), 200),
    ).toStrictEqual({ ok: true });
    expect(actions.markEmailReadCore).toHaveBeenCalledWith(MOBILE_USER, EMAIL_ID, true);

    await post({ action: "mark_unread", email_id: EMAIL_ID });
    expect(actions.markEmailReadCore).toHaveBeenLastCalledWith(MOBILE_USER, EMAIL_ID, false);
  });

  it("moves to the requested folder", async () => {
    const res = await post({ action: "move", email_id: EMAIL_ID, to_folder_id: FOLDER_ID });
    expect(await jsonBody(res, 200)).toStrictEqual({ ok: true });
    expect(actions.moveEmailCore).toHaveBeenCalledWith(MOBILE_USER, EMAIL_ID, FOLDER_ID);
  });

  it("refuses a move with no destination folder, in plain text", async () => {
    const res = await post({ action: "move", email_id: EMAIL_ID });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("to_folder_id is required for move");
    expect(actions.moveEmailCore).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown action", { action: "delete_forever", email_id: EMAIL_ID }],
    ["a non-uuid email_id", { action: "archive", email_id: "42" }],
    ["a missing email_id", { action: "archive" }],
    ["a non-uuid to_folder_id", { action: "move", email_id: EMAIL_ID, to_folder_id: "inbox" }],
  ])("refuses %s with 400 and calls no core action", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid request body");
    expect(noCoreCalled()).toBe(true);
  });

  it("refuses a body that is not JSON", async () => {
    const res = await POST(mobileRequest("/api/mobile/emails/action", { rawBody: "" }));
    expect(res.status).toBe(400);
    expect(noCoreCalled()).toBe(true);
    expect(writeCount(fake)).toBe(0);
  });

  it("turns a refusal from the core (a foreign email id) into a 400 with its message", async () => {
    actions.archiveEmailCore.mockRejectedValue(new Error("Email not found"));
    expect(
      await jsonBody(await post({ action: "archive", email_id: EMAIL_ID }), 400),
    ).toStrictEqual({ ok: false, error: "Email not found" });
  });

  it("falls back to a generic message when the thrown value has none", async () => {
    actions.moveEmailCore.mockRejectedValue({ code: 500 });
    expect(
      await jsonBody(
        await post({ action: "move", email_id: EMAIL_ID, to_folder_id: FOLDER_ID }),
        400,
      ),
    ).toStrictEqual({ ok: false, error: "Action failed" });
  });
});
