// Shared auth for cron/webhook endpoints under /api/public/*.
// Requires `Authorization: Bearer <CRON_SECRET>` or `x-cron-secret: <CRON_SECRET>`.
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
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;

  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : null;
  const cronHeader = request.headers.get("x-cron-secret");
  const provided = bearer ?? cronHeader;
  if (!provided) return false;
  return constantTimeEq(provided, cronSecret);
}

export function unauthorizedResponse(): Response {
  return new Response("Unauthorized", { status: 401 });
}
