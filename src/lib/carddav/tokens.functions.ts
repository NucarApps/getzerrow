// User-facing management of CardDAV app passwords. The token is shown to
// the user ONCE (right after creation) and only the SHA-256 hash lands in
// the database — same shape as GitHub personal access tokens.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type CardDavTokenRow = {
  id: string;
  label: string;
  last_used_at: string | null;
  created_at: string;
};

function hash(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** List the caller's active (non-revoked) CardDAV tokens. */
export const listCardDavTokens = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("carddav_tokens")
      .select("id,label,last_used_at,created_at")
      .is("revoked_at", null)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { tokens: (data as CardDavTokenRow[] | null) ?? [] };
  });

/** Create a new CardDAV token. Returns the raw value once — never stored. */
export const createCardDavToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ label: z.string().trim().min(1).max(60) }).parse(d))
  .handler(async ({ data, context }) => {
    // 24 bytes -> 32 base64url chars: readable enough for one-time copy
    // and enough entropy that guessing is infeasible.
    const raw = randomBytes(24).toString("base64url");
    const { data: inserted, error } = await context.supabase
      .from("carddav_tokens")
      .insert({
        user_id: context.userId,
        label: data.label,
        token_hash: hash(raw),
      })
      .select("id,label,created_at")
      .single();
    if (error) throw new Error(error.message);
    return { token: raw, row: inserted };
  });

/** Revoke a CardDAV token so the iPhone stops syncing. */
export const revokeCardDavToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("carddav_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
