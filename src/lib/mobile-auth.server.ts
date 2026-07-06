// Server-only auth helper for the mobile API routes (src/routes/api/mobile/*).
// The Rork/Expo app can't call TanStack server functions, so these HTTP routes
// verify the Supabase bearer token directly and hand back a user-scoped client
// (RLS applies as that user) plus the user id.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type MobileAuth = {
  userId: string;
  supabase: SupabaseClient<Database>;
  token: string;
};

/**
 * Authenticate an incoming mobile API request from its Authorization header.
 * Throws a Response (401) when the caller is not a valid signed-in user, so
 * handlers can `try { await authenticateRequest(request) } catch (r) { return r }`.
 */
export async function authenticateRequest(request: Request): Promise<MobileAuth> {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Response("Server auth is not configured", { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Response("Unauthorized", { status: 401 });
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims?.sub) {
    throw new Response("Unauthorized", { status: 401 });
  }

  return { userId: data.claims.sub, supabase, token };
}
