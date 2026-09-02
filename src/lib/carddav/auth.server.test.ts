import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "../__fixtures__/supabase-fake";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

import { hashToken, carddavAuthChallengeResponse, verifyCardDavAuth } from "./auth.server";

const USER_ID = "11111111-2222-3333-4444-555555555555";

function reqWithAuth(header?: string): Request {
  return new Request("https://app.example/carddav/", {
    headers: header ? { authorization: header } : {},
  });
}

function basic(creds: string): string {
  return `Basic ${btoa(creds)}`;
}

/** What a real client sends for credentials outside Latin-1: the UTF-8 bytes,
 * base64'd. `btoa` alone throws on those characters. */
function basicUtf8(creds: string): string {
  let bin = "";
  for (const byte of new TextEncoder().encode(creds)) bin += String.fromCharCode(byte);
  return `Basic ${btoa(bin)}`;
}

async function expectRejectedWithoutRpc(header?: string) {
  const result = await verifyCardDavAuth(reqWithAuth(header));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.status).toBe(401);
  // Malformed credentials must be rejected locally — no DB roundtrip that an
  // attacker could use as an oracle or a load vector.
  expect(fake.calls.rpcs).toHaveLength(0);
}

beforeEach(() => {
  fake.reset();
});

describe("hashToken", () => {
  it("is SHA-256 hex (known test vector)", () => {
    // NIST vector: sha256("abc")
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hashToken("abd")).not.toBe(hashToken("abc"));
  });
});

describe("carddavAuthChallengeResponse", () => {
  it("is a 401 with the Basic challenge header CardDAV clients require", () => {
    const res = carddavAuthChallengeResponse();
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="Atzro CardDAV"');
  });
});

describe("verifyCardDavAuth", () => {
  it("rejects a request with no Authorization header without any rpc", async () => {
    await expectRejectedWithoutRpc(undefined);
  });

  it("rejects non-Basic schemes without any rpc", async () => {
    await expectRejectedWithoutRpc("Bearer some-token");
  });

  it("rejects invalid base64 credentials without any rpc", async () => {
    await expectRejectedWithoutRpc("Basic %%%not-base64%%%");
  });

  it("rejects credentials without a colon or with an empty username", async () => {
    await expectRejectedWithoutRpc(basic("no-colon-here"));
    await expectRejectedWithoutRpc(basic(":password-only"));
  });

  it("rejects an empty password without any rpc", async () => {
    await expectRejectedWithoutRpc(basic("user@example.com:"));
    await expectRejectedWithoutRpc(basic("   :password"));
  });

  it("valid Basic auth calls verify_carddav_token with lowercased email and hashed token", async () => {
    fake.onRpc("verify_carddav_token", () => ({ data: USER_ID }));
    const result = await verifyCardDavAuth(reqWithAuth(basic("  User@Example.COM :tok-secret")));
    expect(result).toEqual({ ok: true, userId: USER_ID, email: "user@example.com" });
    // The raw token must never reach the DB — only its SHA-256 hash.
    expect(fake.calls.rpcs).toEqual([
      {
        fn: "verify_carddav_token",
        args: { p_user_email: "user@example.com", p_token_hash: hashToken("tok-secret") },
      },
    ]);
  });

  it("scheme match is case-insensitive (BASIC works)", async () => {
    fake.onRpc("verify_carddav_token", () => ({ data: USER_ID }));
    const encoded = btoa("user@example.com:tok");
    const result = await verifyCardDavAuth(reqWithAuth(`BASIC ${encoded}`));
    expect(result.ok).toBe(true);
  });

  it("rejects when the rpc errors", async () => {
    fake.onRpc("verify_carddav_token", () => ({ error: { message: "db down" } }));
    const result = await verifyCardDavAuth(reqWithAuth(basic("user@example.com:tok")));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("keeps every colon after the first as part of the password", async () => {
    // RFC 7617: the username cannot contain a colon, the password can. A
    // generated app password is base64url today, but splitting on the LAST
    // colon (or on all of them) would silently truncate a pasted password.
    fake.onRpc("verify_carddav_token", () => ({ data: USER_ID }));
    const result = await verifyCardDavAuth(reqWithAuth(basic("user@example.com:pa:ss:word")));
    expect(result.ok).toBe(true);
    expect(fake.calls.rpcs[0]!.args).toEqual({
      p_user_email: "user@example.com",
      p_token_hash: hashToken("pa:ss:word"),
    });
  });

  it("does not trim the password (a trailing space is part of the secret)", async () => {
    fake.onRpc("verify_carddav_token", () => ({ data: USER_ID }));
    await verifyCardDavAuth(reqWithAuth(basic("user@example.com: spaced ")));
    expect(fake.calls.rpcs[0]!.args.p_token_hash).toBe(hashToken(" spaced "));
  });

  it("decodes a non-ASCII email as UTF-8, so the address matches the stored one", async () => {
    // Regression: `atob` yields a BYTE string, so the UTF-8 bytes of "é"
    // (C3 A9) arrived as the two Latin-1 characters "Ã©" and the lookup
    // could never match — an account with a non-ASCII address could not
    // pair a phone, and the failure looked like a wrong password.
    fake.onRpc("verify_carddav_token", () => ({ data: null }));
    await verifyCardDavAuth(reqWithAuth(basicUtf8("josé@example.com:tok-secret")));
    expect(fake.calls.rpcs[0]!.args.p_user_email).toBe("josé@example.com");
  });

  it("hashes the password the user actually typed, not its mojibake", async () => {
    fake.onRpc("verify_carddav_token", () => ({ data: null }));
    await verifyCardDavAuth(reqWithAuth(basicUtf8("user@example.com:pässwörd")));
    expect(fake.calls.rpcs[0]!.args.p_token_hash).toBe(hashToken("pässwörd"));
  });

  it("rejects when the rpc finds no matching token (null data)", async () => {
    fake.onRpc("verify_carddav_token", () => ({ data: null }));
    const result = await verifyCardDavAuth(reqWithAuth(basic("user@example.com:wrong")));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
});
