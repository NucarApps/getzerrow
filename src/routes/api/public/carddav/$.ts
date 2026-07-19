// Read-only CardDAV endpoint. Splat route captures every method + subpath
// under /api/public/carddav/. The prefix bypasses Lovable's published-site
// auth; we authenticate with Basic + per-device app password (hashed) in
// verify_carddav_token.

import { createFileRoute } from "@tanstack/react-router";

type Params = { _splat?: string };

// Per-user debounce for the post-sync photo backfill. iPhone hammers REPORT
// during a full sync (one per address book, plus multigets); we only need to
// kick the backfill once per user per minute.
const PHOTO_BACKFILL_DEBOUNCE_MS = 60_000;
const lastPhotoBackfillAt = new Map<string, number>();

/** Fire-and-forget: clear `photo_etag` for every Gmail account under the user
 * whose linked contacts are missing a local avatar. The next scheduled Google
 * pull refetches those photos, so iPhone-added contacts (or contacts whose
 * photo download previously failed) self-heal without a button click. */
function triggerPhotoBackfill(userId: string): void {
  const now = Date.now();
  const last = lastPhotoBackfillAt.get(userId) ?? 0;
  if (now - last < PHOTO_BACKFILL_DEBOUNCE_MS) return;
  lastPhotoBackfillAt.set(userId, now);

  void (async () => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { autoClearMissingPhotoEtags } = await import("@/lib/google-contacts/reconcile.server");
      const { data: accts } = await supabaseAdmin
        .from("gmail_accounts")
        .select("id")
        .eq("user_id", userId);
      for (const a of accts ?? []) {
        await autoClearMissingPhotoEtags(userId, (a as { id: string }).id);
      }
    } catch {
      // Non-fatal — the CardDAV response has already been sent.
    }
  })();
}

async function dispatch(request: Request, params: Params): Promise<Response> {
  const { verifyCardDavAuth } = await import("@/lib/carddav/auth.server");
  const { handleOptions, handlePropfind, handleReport, handleGet, handlePut, handleDelete } =
    await import("@/lib/carddav/handlers.server");

  const path = params._splat ?? "";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return handleOptions();

  const auth = await verifyCardDavAuth(request);
  if (!auth.ok) return auth.response;

  if (method === "PROPFIND") {
    return handlePropfind(request, auth.userId, auth.email, path);
  }
  if (method === "REPORT") {
    const response = await handleReport(request, auth.userId, auth.email);
    // iPhone finished a sync-collection pull — opportunistically clear stale
    // photo etags so the next Google sync refills any missing avatars.
    triggerPhotoBackfill(auth.userId);
    return response;
  }
  if (method === "GET" || method === "HEAD") {
    return handleGet(request, auth.userId, auth.email, path, method);
  }
  if (method === "PUT") {
    const response = await handlePut(request, auth.userId, auth.email, path);
    // iPhone just wrote a contact (add/edit) — same backfill trigger so any
    // Google-side photo we haven't cached shows up on the next pull.
    triggerPhotoBackfill(auth.userId);
    return response;
  }
  if (method === "DELETE") {
    return handleDelete(request, auth.userId, path);
  }
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT" },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyHandler = async ({ request, params }: any) => dispatch(request, params as Params);

export const Route = createFileRoute("/api/public/carddav/$")({
  server: {
    // Route by request method; ANY catches PROPFIND/REPORT and anything else.
    handlers: {
      GET: anyHandler,
      HEAD: anyHandler,
      OPTIONS: anyHandler,
      ANY: anyHandler,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  },
});
