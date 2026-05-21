// Shared auth for cron/webhook endpoints under /api/public/*.
// Accepts EITHER:
//   1. `Authorization: Bearer <CRON_SECRET>` / `x-cron-secret: <CRON_SECRET>`
//      (manual calls + legacy schedules), OR
//   2. `apikey: <SUPABASE_PUBLISHABLE_KEY>` (the standard pg_cron pattern).
// The publishable/anon key is safe to embed in cron SQL — it's a public key.
function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isAuthorizedCron(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const anonKey =
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    null;

  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const cronHeader = request.headers.get("x-cron-secret");
  const apikeyHeader = request.headers.get("apikey");

  // Bearer / x-cron-secret path — must match CRON_SECRET
  if (cronSecret) {
    const provided = bearer ?? cronHeader;
    if (provided && constantTimeEq(provided, cronSecret)) return true;
  }

  // apikey path — must match the publishable key
  if (anonKey && apikeyHeader && constantTimeEq(apikeyHeader, anonKey)) {
    return true;
  }

  return false;
}

export function unauthorizedResponse(): Response {
  return new Response("Unauthorized", { status: 401 });
}
