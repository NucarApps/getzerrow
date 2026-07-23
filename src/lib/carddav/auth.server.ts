// Basic-auth verification for the CardDAV routes. Username is the user's
// Zerrow email, password is a token generated in Settings and stored as an
// unsalted SHA-256 hash. Never accepts the real login password. Verification
// compares the SHA-256 of the presented token against the stored hash inside a
// SECURITY DEFINER helper (a plain equality lookup — not a constant-time
// compare, which is acceptable here only because the token is a high-entropy
// random secret, so a timing side-channel yields no practical advantage).

import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function unauthorizedResponse(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Zerrow CardDAV"',
      "Content-Type": "text/plain",
    },
  });
}

export type AuthResult =
  { ok: true; userId: string; email: string } | { ok: false; response: Response };

export async function verifyCardDavAuth(request: Request): Promise<AuthResult> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("basic ")) {
    return { ok: false, response: unauthorizedResponse() };
  }
  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return { ok: false, response: unauthorizedResponse() };
  }
  const idx = decoded.indexOf(":");
  if (idx <= 0) return { ok: false, response: unauthorizedResponse() };
  const email = decoded.slice(0, idx).trim().toLowerCase();
  const password = decoded.slice(idx + 1);
  if (!email || !password) return { ok: false, response: unauthorizedResponse() };

  const hash = hashToken(password);
  const { data, error } = await supabaseAdmin.rpc("verify_carddav_token", {
    p_user_email: email,
    p_token_hash: hash,
  } as never);
  if (error || !data) return { ok: false, response: unauthorizedResponse() };
  return { ok: true, userId: data as string, email };
}
