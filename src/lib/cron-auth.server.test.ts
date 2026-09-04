// The gate on all 28 /api/public/* cron and webhook routes.
//
// It was previously tested through `isAuthorizedCron`, a synchronous
// sibling that NO production code called — so the env-secret path had
// thirteen tests while the path routes actually use had none, and its
// database fallback (the one that keeps cron working when CRON_SECRET is
// rotated in Postgres but not yet in the Worker env) was untested
// entirely. The dead function is gone; every case below runs against
// `isAuthorizedCronRequest`.
//
// What matters here, in order:
//   * the Supabase publishable key is shipped in the client bundle and
//     provides no access control, so it must never open this gate,
//   * comparison against the env secret is constant-time, so a
//     same-length near-miss is refused without leaking where it diverged,
//   * the database fallback answers only to a literal `true`. The RPC
//     returns a boolean, but PostgREST has been known to hand back the
//     STRING "true", which is truthy — a loose check there would accept
//     any non-empty answer, including from a failed call,
//   * a fallback that errors or throws is a closed door, not an open one.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const { isAuthorizedCronRequest, unauthorizedResponse } = await import("./cron-auth.server");

const SECRET = "test-secret-abcdef1234567890";
/** What the database would hold after a rotation the env has not caught up with. */
const ROTATED = "rotated-secret-0987654321fedcba";

function reqWith(headers: Record<string, string>): Request {
  return new Request("https://example.com/api/public/anything", { headers });
}

/** The RPC answers true only for the rotated secret. */
function dbKnows(secret: string) {
  fake.onRpc("cron_secret_matches", (args) => ({ data: args.provided === secret }));
}

beforeEach(() => {
  fake.reset();
  vi.stubEnv("CRON_SECRET", SECRET);
  // Default: the database knows nothing, so only the env secret works.
  fake.onRpc("cron_secret_matches", () => ({ data: false }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("what reaches the gate", () => {
  it("refuses a request carrying no secret at all, without asking the database", async () => {
    await expect(isAuthorizedCronRequest(reqWith({}))).resolves.toBe(false);
    expect(fake.calls.rpcs).toEqual([]);
  });

  it("accepts the secret in either header", async () => {
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: `Bearer ${SECRET}` })),
    ).resolves.toBe(true);
    await expect(isAuthorizedCronRequest(reqWith({ "x-cron-secret": SECRET }))).resolves.toBe(true);
  });

  it("reads Bearer case-insensitively and trims it", async () => {
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: `bearer   ${SECRET}  ` })),
    ).resolves.toBe(true);
  });

  it("ignores an x-cron-secret when an Authorization header is present", async () => {
    // Bearer wins, so a request is judged on the header an operator would
    // have set deliberately rather than on whichever happens to match.
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: "Bearer wrong", "x-cron-secret": SECRET })),
    ).resolves.toBe(false);
  });

  it("refuses a scheme that is not Bearer", async () => {
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: `Basic ${SECRET}` })),
    ).resolves.toBe(false);
    await expect(isAuthorizedCronRequest(reqWith({ authorization: "Bearer" }))).resolves.toBe(
      false,
    );
  });

  it("refuses an empty Bearer without asking the database", async () => {
    await expect(isAuthorizedCronRequest(reqWith({ authorization: "Bearer   " }))).resolves.toBe(
      false,
    );
    expect(fake.calls.rpcs).toEqual([]);
  });
});

describe("the env secret", () => {
  it("refuses a wrong secret", async () => {
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: "Bearer wrong-secret-value" })),
    ).resolves.toBe(false);
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: `Bearer ${SECRET}x` })),
    ).resolves.toBe(false);
  });

  it("refuses a same-length near-miss (the constant-time path)", async () => {
    const tampered = SECRET.slice(0, -1) + (SECRET.endsWith("0") ? "1" : "0");
    expect(tampered).toHaveLength(SECRET.length);
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: `Bearer ${tampered}` })),
    ).resolves.toBe(false);
  });

  it("falls through to the database when the env holds no secret", async () => {
    // A Worker deployed without CRON_SECRET must not lock every cron job
    // out — the database copy is the fallback.
    vi.stubEnv("CRON_SECRET", undefined);
    dbKnows(SECRET);
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: `Bearer ${SECRET}` })),
    ).resolves.toBe(true);
  });

  it("does not ask the database when the env secret already matched", async () => {
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: `Bearer ${SECRET}` })),
    ).resolves.toBe(true);
    expect(fake.calls.rpcs).toEqual([]);
  });
});

describe("the database fallback", () => {
  it("accepts a secret the database knows but the env does not", async () => {
    // This is the rotation window: the secret changed in Postgres and the
    // Worker env has not been redeployed yet.
    dbKnows(ROTATED);
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: `Bearer ${ROTATED}` })),
    ).resolves.toBe(true);
    expect(fake.calls.rpcs[0]).toEqual({
      fn: "cron_secret_matches",
      args: { provided: ROTATED },
    });
  });

  it("refuses a secret neither the env nor the database knows", async () => {
    dbKnows(ROTATED);
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: "Bearer neither" })),
    ).resolves.toBe(false);
  });

  it("answers only to a literal true, never to a truthy value", async () => {
    // PostgREST has handed back the STRING "true" for a boolean column.
    // A loose check would then accept any non-empty answer.
    for (const data of ["true", 1, "t", {}, [], "false"]) {
      fake.reset();
      fake.onRpc("cron_secret_matches", () => ({ data }));
      await expect(
        isAuthorizedCronRequest(reqWith({ authorization: "Bearer whatever" })),
        JSON.stringify(data),
      ).resolves.toBe(false);
    }
  });

  it("refuses a null answer", async () => {
    fake.onRpc("cron_secret_matches", () => ({ data: null }));
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: "Bearer whatever" })),
    ).resolves.toBe(false);
  });

  it("closes the door when the RPC returns an error", async () => {
    fake.onRpc("cron_secret_matches", () => ({ error: { message: "function does not exist" } }));
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: "Bearer whatever" })),
    ).resolves.toBe(false);
  });

  it("closes the door when the RPC throws", async () => {
    // A network failure must not fail open on an admin endpoint.
    fake.onRpc("cron_secret_matches", () => {
      throw new Error("connection reset");
    });
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: "Bearer whatever" })),
    ).resolves.toBe(false);
  });
});

describe("the publishable key", () => {
  it("never opens the gate, through either header or either path", async () => {
    // It ships in the client bundle and provides no access control.
    // Accepting it would let any visitor trigger a DLQ replay.
    const anonKey =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4aWxjaW5sbmF1anh5a3NmamluIiwicm9sZSI6ImFub24ifQ.fake-sig";
    await expect(
      isAuthorizedCronRequest(reqWith({ authorization: `Bearer ${anonKey}` })),
    ).resolves.toBe(false);
    await expect(isAuthorizedCronRequest(reqWith({ "x-cron-secret": anonKey }))).resolves.toBe(
      false,
    );
  });
});

describe("unauthorizedResponse", () => {
  it("is a bare 401", async () => {
    const res = unauthorizedResponse();
    expect(res.status).toBe(401);
    // No detail: an unauthenticated caller learns nothing about why.
    await expect(res.text()).resolves.toBe("Unauthorized");
  });
});
