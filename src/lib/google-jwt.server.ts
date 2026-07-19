// Verify Google-issued OIDC JWTs (used by Pub/Sub push subscriptions when
// configured with pushConfig.oidcToken.serviceAccountEmail).
//
// We use Web Crypto (RS256) so this works in the Workerd runtime — no Node
// `crypto` keys, no native deps. Google's public keys are cached in module
// scope for an hour.

type Jwk = {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
  use?: string;
};

type JwksCache = { keys: Jwk[]; fetchedAt: number };
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour
let jwksCache: JwksCache | null = null;

async function loadJwks(forceRefresh = false): Promise<Jwk[]> {
  if (!forceRefresh && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch failed ${res.status}`);
  const json = (await res.json()) as { keys: Jwk[] };
  jwksCache = { keys: json.keys, fetchedAt: Date.now() };
  return json.keys;
}

function b64urlToBuf(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const norm = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

export type GoogleJwtClaims = {
  iss?: string;
  aud?: string;
  exp?: number;
  iat?: number;
  email?: string;
  email_verified?: boolean;
  sub?: string;
};

export type VerifyOptions = {
  /** Accepted `aud` claim values. Pass at least one. */
  audiences: string[];
  /** Required `email` claim (service account address). Optional. */
  expectedEmail?: string;
  /** Clock skew in seconds. Default 30. */
  clockSkewSec?: number;
};

export type VerifyResult =
  { ok: true; claims: GoogleJwtClaims } | { ok: false; reason: VerifyFailure };

export type VerifyFailure =
  | "malformed"
  | "no_kid"
  | "unknown_kid"
  | "bad_signature"
  | "bad_iss"
  | "bad_aud"
  | "expired"
  | "bad_email";

/** Verify a Google-signed JWT. Returns `{ ok, claims }` on success or `{ ok: false, reason }`. */
export async function verifyGoogleJwt(token: string, opts: VerifyOptions): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let claims: GoogleJwtClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBuf(headerB64)));
    claims = JSON.parse(new TextDecoder().decode(b64urlToBuf(payloadB64)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!header.kid) return { ok: false, reason: "no_kid" };

  // Fetch JWKS (refresh once on miss in case of key rotation).
  let keys = await loadJwks();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await loadJwks(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return { ok: false, reason: "unknown_kid" };

  const cryptoKey = await importRsaKey(jwk);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = b64urlToBuf(sigB64);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    sig as BufferSource,
    data as BufferSource,
  );
  if (!valid) return { ok: false, reason: "bad_signature" };

  const issOk =
    claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!issOk) return { ok: false, reason: "bad_iss" };

  if (!claims.aud || !opts.audiences.includes(claims.aud)) {
    return { ok: false, reason: "bad_aud" };
  }

  const skew = opts.clockSkewSec ?? 30;
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp + skew < now) return { ok: false, reason: "expired" };

  if (opts.expectedEmail && claims.email !== opts.expectedEmail) {
    return { ok: false, reason: "bad_email" };
  }

  return { ok: true, claims };
}
