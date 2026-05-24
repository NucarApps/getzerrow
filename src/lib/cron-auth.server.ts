import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Shared auth for cron/webhook endpoints under /api/public/*.
// Requires `Authorization: Bearer <cron secret>` or `x-cron-secret: <cron secret>`.
//
// The Supabase publishable/anon key is intentionally bundled into the client
// and therefore provides no access control — it must NOT be accepted here.
// Any pg_cron job must be configured to send the CRON_SECRET as a Bearer
// token in the Authorization header.
function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isAuthorizedCron(request: Request): boolean {
  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : null;
  const cronHeader = request.headers.get("x-cron-secret");
  const provided = bearer ?? cronHeader;
  if (!provided) return false;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return constantTimeEq(provided, cronSecret);
}

type CronSecretRpcClient = {
  rpc: (
    fn: "cron_secret_matches",
    args: { provided: string },
  ) => Promise<{ data: boolean | null; error: { message: string } | null }>;
};

async function matchesDatabaseCronSecret(provided: string): Promise<boolean> {
  try {
    const { data, error } = await (supabaseAdmin as unknown as CronSecretRpcClient).rpc(
      "cron_secret_matches",
      { provided },
    );
    if (error) {
      console.error("cron_secret_matches failed", error.message);
      return false;
    }
    return data === true;
  } catch (e) {
    console.error("cron secret database check failed", e);
    return false;
  }
}

export async function isAuthorizedCronRequest(request: Request): Promise<boolean> {
  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : null;
  const cronHeader = request.headers.get("x-cron-secret");
  const provided = bearer ?? cronHeader;
  if (!provided) return false;

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && constantTimeEq(provided, cronSecret)) return true;

  return matchesDatabaseCronSecret(provided);
}

export function unauthorizedResponse(): Response {
  return new Response("Unauthorized", { status: 401 });
}
