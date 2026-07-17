// Read-only CardDAV endpoint. Splat route captures every method + subpath
// under /api/public/carddav/. The prefix bypasses Lovable's published-site
// auth; we authenticate with Basic + per-device app password (hashed) in
// verify_carddav_token.

import { createFileRoute } from "@tanstack/react-router";

type Params = { _splat?: string };

async function dispatch(request: Request, params: Params): Promise<Response> {
  const { verifyCardDavAuth } = await import("@/lib/carddav/auth.server");
  const {
    handleOptions,
    handlePropfind,
    handleReport,
    handleGet,
    handlePut,
    handleDelete,
  } = await import("@/lib/carddav/handlers.server");

  const path = params._splat ?? "";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return handleOptions();

  const auth = await verifyCardDavAuth(request);
  if (!auth.ok) return auth.response;

  if (method === "PROPFIND") {
    return handlePropfind(request, auth.userId, auth.email, path);
  }
  if (method === "REPORT") {
    return handleReport(request, auth.userId, auth.email);
  }
  if (method === "GET" || method === "HEAD") {
    return handleGet(auth.userId, auth.email, path, method);
  }
  if (method === "PUT") {
    return handlePut(request, auth.userId, auth.email, path);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlers: {
      GET: anyHandler,
      HEAD: anyHandler,
      OPTIONS: anyHandler,
      ANY: anyHandler,
    } as any,
  },
});
