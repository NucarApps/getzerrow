// Verifies google-jwt.server against REAL RS256 signatures: a real RSA
// keypair is generated once, tokens are signed with the private key, and the
// public key is served as a JWK through a stubbed JWKS fetch. No crypto mocks.
//
// The module caches the JWKS in module scope for an hour, so tests that need
// a fresh cache re-import the module via vi.resetModules() + dynamic import.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

type Jwk = { kid: string; kty: string; alg: string; n: string; e: string };
type JwtModule = typeof import("./google-jwt.server");
type Claims = Record<string, unknown>;

const KID = "test-kid-1";
const AUD = "https://push.example/endpoint";
const EMAIL = "pubsub@system.gserviceaccount.com";

let privateKey: CryptoKey;
let publicJwk: Jwk;

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlFromJson(obj: unknown): string {
  return b64urlFromBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

async function signToken(claims: Claims, header?: Record<string, unknown>): Promise<string> {
  const h = b64urlFromJson(header ?? { alg: "RS256", kid: KID, typ: "JWT" });
  const p = b64urlFromJson(claims);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

function baseClaims(overrides: Claims = {}): Claims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: AUD,
    exp: now + 3600,
    iat: now,
    email: EMAIL,
    email_verified: true,
    sub: "1234567890",
    ...overrides,
  };
}

/** Stub fetch to serve the given JWKS responses in order (last one repeats). */
function stubJwks(...keySets: Jwk[][]) {
  const fetchMock = vi.fn(async () => {
    const idx = Math.min(fetchMock.mock.calls.length - 1, keySets.length - 1);
    return new Response(JSON.stringify({ keys: keySets[idx] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function importSut(): Promise<JwtModule> {
  return import("./google-jwt.server");
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  publicJwk = { kid: KID, kty: exported.kty!, alg: "RS256", n: exported.n!, e: exported.e! };
});

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyGoogleJwt", () => {
  it("accepts a validly signed token and returns its claims", async () => {
    stubJwks([publicJwk]);
    const mod = await importSut();
    const token = await signToken(baseClaims());
    const result = await mod.verifyGoogleJwt(token, { audiences: [AUD] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.email).toBe(EMAIL);
      expect(result.claims.aud).toBe(AUD);
      expect(result.claims.sub).toBe("1234567890");
    }
  });

  it("rejects a token whose payload was swapped after signing (bad_signature)", async () => {
    stubJwks([publicJwk]);
    const mod = await importSut();
    const token = await signToken(baseClaims());
    const [h, , sig] = token.split(".");
    const forgedPayload = b64urlFromJson(baseClaims({ email: "attacker@evil.example" }));
    const result = await mod.verifyGoogleJwt(`${h}.${forgedPayload}.${sig}`, {
      audiences: [AUD],
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a non-Google issuer even with a valid signature (bad_iss)", async () => {
    stubJwks([publicJwk]);
    const mod = await importSut();
    const token = await signToken(baseClaims({ iss: "https://accounts.evil.example" }));
    const result = await mod.verifyGoogleJwt(token, { audiences: [AUD] });
    expect(result).toEqual({ ok: false, reason: "bad_iss" });
  });

  it("accepts the schemeless issuer form Google also uses", async () => {
    stubJwks([publicJwk]);
    const mod = await importSut();
    const token = await signToken(baseClaims({ iss: "accounts.google.com" }));
    const result = await mod.verifyGoogleJwt(token, { audiences: [AUD] });
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong or missing aud (bad_aud)", async () => {
    stubJwks([publicJwk]);
    const mod = await importSut();
    const wrongAud = await signToken(baseClaims({ aud: "https://other.example" }));
    expect(await mod.verifyGoogleJwt(wrongAud, { audiences: [AUD] })).toEqual({
      ok: false,
      reason: "bad_aud",
    });
    const noAud = await signToken(baseClaims({ aud: undefined }));
    expect(await mod.verifyGoogleJwt(noAud, { audiences: [AUD] })).toEqual({
      ok: false,
      reason: "bad_aud",
    });
  });

  it("rejects a token expired beyond the clock-skew allowance", async () => {
    stubJwks([publicJwk]);
    const mod = await importSut();
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(baseClaims({ exp: now - 120 }));
    const result = await mod.verifyGoogleJwt(token, { audiences: [AUD] });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a token expired within the default 30s skew window", async () => {
    stubJwks([publicJwk]);
    const mod = await importSut();
    const now = Math.floor(Date.now() / 1000);
    // exp 10s in the past: exp + 30 >= now, so still inside the skew boundary.
    const token = await signToken(baseClaims({ exp: now - 10 }));
    const result = await mod.verifyGoogleJwt(token, { audiences: [AUD] });
    expect(result.ok).toBe(true);
  });

  it("rejects structurally malformed tokens without touching the network", async () => {
    const fetchMock = stubJwks([publicJwk]);
    const mod = await importSut();
    expect(await mod.verifyGoogleJwt("only.two", { audiences: [AUD] })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await mod.verifyGoogleJwt("%%%.%%%.%%%", { audiences: [AUD] })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a header without kid before fetching keys (no_kid)", async () => {
    const fetchMock = stubJwks([publicJwk]);
    const mod = await importSut();
    const token = await signToken(baseClaims(), { alg: "RS256", typ: "JWT" });
    expect(await mod.verifyGoogleJwt(token, { audiences: [AUD] })).toEqual({
      ok: false,
      reason: "no_kid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unknown kid forces a second (fresh) JWKS fetch before giving up", async () => {
    const otherJwk = { ...publicJwk, kid: "some-other-kid" };
    const fetchMock = stubJwks([otherJwk]);
    const mod = await importSut();
    const token = await signToken(baseClaims());
    const result = await mod.verifyGoogleJwt(token, { audiences: [AUD] });
    expect(result).toEqual({ ok: false, reason: "unknown_kid" });
    // The forced refresh bypasses the fresh 1h cache — exactly two fetches.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers from key rotation: refreshed JWKS contains the new kid", async () => {
    const staleJwk = { ...publicJwk, kid: "rotated-away" };
    const fetchMock = stubJwks([staleJwk], [publicJwk]);
    const mod = await importSut();
    const token = await signToken(baseClaims());
    const result = await mod.verifyGoogleJwt(token, { audiences: [AUD] });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches the JWKS across verifies (one fetch for many tokens)", async () => {
    const fetchMock = stubJwks([publicJwk]);
    const mod = await importSut();
    const t1 = await signToken(baseClaims());
    const t2 = await signToken(baseClaims({ sub: "other-sub" }));
    expect((await mod.verifyGoogleJwt(t1, { audiences: [AUD] })).ok).toBe(true);
    expect((await mod.verifyGoogleJwt(t2, { audiences: [AUD] })).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("enforces expectedEmail when provided (bad_email)", async () => {
    stubJwks([publicJwk]);
    const mod = await importSut();
    const token = await signToken(baseClaims());
    expect(
      await mod.verifyGoogleJwt(token, { audiences: [AUD], expectedEmail: "other@x.example" }),
    ).toEqual({ ok: false, reason: "bad_email" });
    const ok = await mod.verifyGoogleJwt(token, { audiences: [AUD], expectedEmail: EMAIL });
    expect(ok.ok).toBe(true);
  });
});
