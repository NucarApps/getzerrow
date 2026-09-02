// CardDAV app passwords. These are the only credential a phone ever holds
// for this account, so the contracts are narrow and absolute:
//
//   * the raw token is returned exactly once and is never persisted — only
//     its SHA-256 hex lands in carddav_tokens.token_hash;
//   * the hash written here is byte-for-byte the hash the auth path
//     recomputes from the Basic-auth password, or every issued token would
//     be dead on arrival;
//   * revocation is filtered by the caller's own user_id, so knowing a token
//     row's uuid is not enough to disable someone else's phone.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, writesTo } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";
import { callWithRlsClient } from "@/lib/__fixtures__/rls-server-fn";

const fake = makeSupabaseFake({ applyWrites: true });

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { listCardDavTokens, createCardDavToken, revokeCardDavToken } from "./tokens.functions";
import { hashToken } from "./auth.server";

const ATTACKER = "attacker-user-9";
const MY_TOKEN = "11111111-1111-4111-8111-111111111111";
const VICTIM_TOKEN = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-01T09:30:00.000Z");

type CreatedRow = { id: string; label: string; created_at: string };
type CreateResult = { token: string; row: CreatedRow };

/** PostgREST projects the trailing `.select("id,label,created_at")`; the fake
 * echoes the whole payload back, so model the projection explicitly rather
 * than let the token hash leak into the assertion by accident. */
function projectInsertedRow(): void {
  fake.onInsert("carddav_tokens", (payload) => ({
    data: {
      id: MY_TOKEN,
      label: (payload as { label: string }).label,
      created_at: NOW.toISOString(),
    },
  }));
}

async function createToken(label = "iPhone 15"): Promise<CreateResult> {
  return (await callWithRlsClient(createCardDavToken, { fake })({
    data: { label },
  })) as CreateResult;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  fake.reset();
  fake.seed("carddav_tokens", []);
});

describe("createCardDavToken", () => {
  it("returns the raw token once and stores only its SHA-256 hex", async () => {
    projectInsertedRow();
    const result = await createToken("iPhone 15");

    // 24 random bytes rendered base64url: URL-safe, 32 chars, no padding.
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(result.row).toStrictEqual({
      id: MY_TOKEN,
      label: "iPhone 15",
      created_at: NOW.toISOString(),
    });
    // Whatever comes back to the browser must not contain the stored secret.
    expect(JSON.stringify(result.row)).not.toContain("token_hash");

    const inserts = writesTo(fake, "inserts", "carddav_tokens");
    expect(inserts).toHaveLength(1);
    const payload = inserts[0]!.payload as { user_id: string; label: string; token_hash: string };
    expect(payload.user_id).toBe(TEST_USER);
    expect(payload.label).toBe("iPhone 15");
    expect(payload.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // The raw value must be nowhere in the row we persist.
    expect(JSON.stringify(payload)).not.toContain(result.token);
  });

  it("writes the same hash the Basic-auth path recomputes from the password", async () => {
    // If these two ever diverged, every freshly issued token would 401 on
    // the phone with no error anywhere to explain it.
    projectInsertedRow();
    const result = await createToken();
    const payload = writesTo(fake, "inserts", "carddav_tokens")[0]!.payload as {
      token_hash: string;
    };
    expect(payload.token_hash).toBe(hashToken(result.token));
  });

  it("mints a different secret every time", async () => {
    projectInsertedRow();
    const a = await createToken("phone a");
    const b = await createToken("phone b");
    expect(a.token).not.toBe(b.token);
    const hashes = writesTo(fake, "inserts", "carddav_tokens").map(
      (w) => (w.payload as { token_hash: string }).token_hash,
    );
    expect(new Set(hashes).size).toBe(2);
  });

  it("rejects a blank or over-long label before minting anything", async () => {
    await expect(createToken("   ")).rejects.toThrow();
    await expect(createToken("x".repeat(61))).rejects.toThrow();
    expect(writesTo(fake, "inserts", "carddav_tokens")).toHaveLength(0);
  });

  it("surfaces an insert failure instead of handing back an unusable token", async () => {
    fake.onInsert("carddav_tokens", () => ({ message: "insert token failed" }));
    await expect(createToken()).rejects.toThrow("insert token failed");
  });
});

describe("listCardDavTokens", () => {
  it("lists non-revoked tokens newest first and never exposes the hash column", async () => {
    // RLS-RELIANCE: the query has no user_id filter, so the row visibility
    // the policy produces is modelled by seeding only the caller's rows.
    fake.seed("carddav_tokens", [
      {
        id: MY_TOKEN,
        user_id: TEST_USER,
        label: "old phone",
        created_at: "2026-01-01T00:00:00.000Z",
        last_used_at: null,
        revoked_at: null,
      },
      {
        id: VICTIM_TOKEN,
        user_id: TEST_USER,
        label: "revoked phone",
        created_at: "2026-05-01T00:00:00.000Z",
        last_used_at: null,
        revoked_at: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        user_id: TEST_USER,
        label: "new phone",
        created_at: "2026-07-01T00:00:00.000Z",
        last_used_at: "2026-07-02T00:00:00.000Z",
        revoked_at: null,
      },
    ]);

    const { tokens } = (await callWithRlsClient(listCardDavTokens, { fake })()) as {
      tokens: Array<{ id: string; label: string }>;
    };
    expect(tokens.map((t) => t.label)).toEqual(["new phone", "old phone"]);

    const select = fake.calls.selects.find((s) => s.table === "carddav_tokens");
    expect(select?.columns).toBe("id,label,last_used_at,created_at");
    expect(select?.filters).toEqual([
      { op: "is", col: "revoked_at", value: null, extra: undefined },
    ]);
  });

  it("throws when the listing query fails", async () => {
    fake.onSelect("carddav_tokens", () => ({ message: "list failed" }));
    await expect(callWithRlsClient(listCardDavTokens, { fake })()).rejects.toThrow("list failed");
  });
});

describe("revokeCardDavToken", () => {
  beforeEach(() => {
    fake.seed("carddav_tokens", [
      {
        id: MY_TOKEN,
        user_id: TEST_USER,
        label: "mine",
        revoked_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: VICTIM_TOKEN,
        user_id: "victim-user-3",
        label: "not mine",
        revoked_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("stamps revoked_at on the caller's own token", async () => {
    const result = await callWithRlsClient(revokeCardDavToken, { fake })({
      data: { id: MY_TOKEN },
    });
    expect(result).toStrictEqual({ ok: true });

    const updates = writesTo(fake, "updates", "carddav_tokens");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toStrictEqual({ revoked_at: NOW.toISOString() });
    expect(updates[0]!.filters).toEqual([
      { op: "eq", col: "id", value: MY_TOKEN, extra: undefined },
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
    ]);
  });

  it("cannot revoke another user's token even with its exact uuid", async () => {
    // Knowing a token row's id must not be enough to knock someone's phone
    // off sync: the update is filtered by the verified caller as well.
    await impersonate(revokeCardDavToken, ATTACKER, { supabase: fake.client })({
      data: { id: VICTIM_TOKEN },
    });

    const updates = writesTo(fake, "updates", "carddav_tokens");
    expect(updates[0]!.filters).toContainEqual({
      op: "eq",
      col: "user_id",
      value: ATTACKER,
      extra: undefined,
    });
    const victim = fake.rows("carddav_tokens").find((r) => r.id === VICTIM_TOKEN);
    expect(victim?.revoked_at).toBeNull();
  });

  it("rejects a non-uuid id before touching the table", async () => {
    await expect(
      callWithRlsClient(revokeCardDavToken, { fake })({ data: { id: "not-a-uuid" } }),
    ).rejects.toThrow();
    expect(writesTo(fake, "updates", "carddav_tokens")).toHaveLength(0);
  });

  it("throws when the revoke write fails", async () => {
    fake.onUpdate("carddav_tokens", () => ({ message: "revoke failed" }));
    await expect(
      callWithRlsClient(revokeCardDavToken, { fake })({ data: { id: MY_TOKEN } }),
    ).rejects.toThrow("revoke failed");
  });
});
