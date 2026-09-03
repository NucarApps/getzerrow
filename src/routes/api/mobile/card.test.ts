// Authorised-path contract for /api/mobile/card — the signed-in user's
// shareable contact card, as the iOS app reads and writes it.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import {
  MOBILE_USER,
  OTHER_USER,
  jsonBody,
  mobileRequest,
  mockMobileAuth,
  rlsScoped,
  serverHandler,
} from "@/lib/__fixtures__/mobile-route-harness";
import * as cardRoute from "./card";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));
vi.mock("@/lib/mobile-auth.server", () => mockMobileAuth(() => fake));

const GET = serverHandler(cardRoute, "GET");
const POST = serverHandler(cardRoute, "POST");

function post(body: unknown) {
  return POST(mobileRequest("/api/mobile/card", { body }));
}

beforeEach(() => {
  fake.reset();
});

describe("GET /api/mobile/card", () => {
  it("returns a null card before the user has set one up", async () => {
    fake.seed("my_cards", []);
    expect(
      await jsonBody(await GET(mobileRequest("/api/mobile/card", { method: "GET" })), 200),
    ).toStrictEqual({ card: null });
  });

  it("returns only the caller's own card row", async () => {
    fake.seed("my_cards", [
      { id: "c-other", user_id: OTHER_USER, handle: "victim", name: "Victim" },
      { id: "c-mine", user_id: MOBILE_USER, handle: "mine", name: "Me" },
    ]);
    // The GET has no user filter of its own — RLS on the user-scoped client
    // is the whole guard, so the fake has to enforce it for the test to mean
    // anything.
    rlsScoped(fake, "my_cards", MOBILE_USER);

    const body = await jsonBody<{ card: { handle: string; name: string } }>(
      await GET(mobileRequest("/api/mobile/card", { method: "GET" })),
      200,
    );
    expect(body.card.handle).toBe("mine");
    expect(body.card.name).toBe("Me");
  });
});

describe("POST /api/mobile/card", () => {
  it("upserts on user_id and normalizes bare URLs", async () => {
    const res = await post({
      handle: "jane-doe",
      name: "Jane Doe",
      title: "CTO",
      company: "Acme",
      email: "jane@acme.test",
      phone: "+1 555 0100",
      website: "acme.test",
      linkedin: "https://linkedin.com/in/jane",
      twitter: "  ",
      tagline: "We build things",
      theme: "ocean",
    });

    expect(await jsonBody(res, 200)).toStrictEqual({
      ok: true,
      card: {
        user_id: MOBILE_USER,
        handle: "jane-doe",
        name: "Jane Doe",
        title: "CTO",
        company: "Acme",
        email: "jane@acme.test",
        phone: "+1 555 0100",
        website: "https://acme.test",
        linkedin: "https://linkedin.com/in/jane",
        // A whitespace-only URL becomes null rather than an invalid link.
        twitter: null,
        // Omitted URL fields are preprocessed to an explicit null (see the
        // omitted-field test below), so they are part of the write.
        avatar_url: null,
        cover_url: null,
        tagline: "We build things",
        theme: "ocean",
      },
    });
    expect(fake.calls.upserts).toHaveLength(1);
    expect(fake.calls.upserts[0]?.table).toBe("my_cards");
    expect(fake.calls.upserts[0]?.options).toStrictEqual({ onConflict: "user_id" });
  });

  it("writes a null for every omitted URL field but leaves omitted text fields out", async () => {
    // Asymmetry the app has to know about: `urlField` preprocesses undefined
    // to null, so a save that omits `website` CLEARS it, while a save that
    // omits `name` leaves the stored name alone (the column is not in the
    // upsert payload at all).
    await post({ handle: "jane" });
    expect(fake.calls.upserts[0]?.payload).toStrictEqual({
      user_id: MOBILE_USER,
      handle: "jane",
      website: null,
      linkedin: null,
      twitter: null,
      avatar_url: null,
      cover_url: null,
    });
  });

  it("keeps an http:// avatar as-is (the web's upsertMyCard forces https)", async () => {
    const body = await jsonBody<{ card: { avatar_url: string; cover_url: string } }>(
      await post({ handle: "jane", avatar_url: "http://cdn.test/a.png", cover_url: "cdn.test/c" }),
      200,
    );
    expect(body.card.avatar_url).toBe("http://cdn.test/a.png");
    expect(body.card.cover_url).toBe("https://cdn.test/c");
  });

  it("refuses a handle already held by another user with 409 and writes nothing", async () => {
    fake.seed("my_cards", [{ id: "c-other", user_id: OTHER_USER, handle: "taken" }]);

    const res = await post({ handle: "taken", name: "Impostor" });
    expect(await jsonBody(res, 409)).toStrictEqual({
      ok: false,
      error: "That handle is already taken — try another.",
    });
    expect(writeCount(fake)).toBe(0);
  });

  it("lets the owner keep their own handle", async () => {
    fake.seed("my_cards", [{ id: "c-mine", user_id: MOBILE_USER, handle: "mine" }]);
    const res = await post({ handle: "mine", name: "Renamed" });
    expect(await jsonBody<{ ok: boolean }>(res, 200)).toMatchObject({ ok: true });
    expect(fake.calls.upserts).toHaveLength(1);
  });

  it.each([
    ["too short", "ab"],
    // The handle regex only accepts lower case, and the route's
    // `toLowerCase()` runs after validation — so an upper-case handle is
    // refused outright rather than folded.
    ["upper case", "JaneDoe"],
    ["punctuated", "jane.doe"],
    ["leading dash", "-jane"],
    ["over 31 chars", "j".repeat(32)],
  ])("refuses a %s handle with 400 and no read of my_cards", async (_label, handle) => {
    const res = await post({ handle, name: "Jane" });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid card data");
    expect(fake.calls.selects).toEqual([]);
    expect(writeCount(fake)).toBe(0);
  });

  it("refuses a malformed email", async () => {
    expect((await post({ handle: "jane", email: "not-an-email" })).status).toBe(400);
  });

  it("refuses a body that is not JSON", async () => {
    const res = await POST(mobileRequest("/api/mobile/card", { rawBody: "{" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid card data");
  });

  it("surfaces an upsert failure as 400 with the message", async () => {
    fake.onUpsert("my_cards", () => ({ message: "handle constraint violated" }));
    expect(await jsonBody(await post({ handle: "jane" }), 400)).toStrictEqual({
      ok: false,
      error: "handle constraint violated",
    });
  });
});
