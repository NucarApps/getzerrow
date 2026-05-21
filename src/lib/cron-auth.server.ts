// Shared secret auth for cron/webhook endpoints under /api/public/*.
// Callers must send `Authorization: Bearer <CRON_SECRET>` or `x-cron-secret: <CRON_SECRET>`.
export function isAuthorizedCron(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const header = request.headers.get("x-cron-secret");
  const provided = bearer ?? header;
  if (!provided || provided.length !== expected.length) return false;
  // Constant-time compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

export function unauthorizedResponse(): Response {
  return new Response("Unauthorized", { status: 401 });
}
