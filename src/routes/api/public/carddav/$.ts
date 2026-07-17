// Read-only CardDAV endpoint. Splat route captures every method + subpath
// under /api/public/carddav/. The prefix bypasses Lovable's published-site
// auth; we authenticate with Basic + per-device app password (hashed) in
// verify_carddav_token.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/carddav/$")({
  server: {
    handlers: ({ createHandlers }) => {
      const dispatch = async (request: Request, params: { _splat?: string }) => {
        const { verifyCardDavAuth } = await import("@/lib/carddav/auth.server");
        const {
          handleOptions,
          handlePropfind,
          handleReport,
          handleGet,
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
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "OPTIONS, GET, HEAD, PROPFIND, REPORT" },
        });
      };

      // TanStack surfaces standard verbs directly; DAV verbs come via a
      // catch-all so PROPFIND/REPORT reach us intact.
      return createHandlers({
        GET: async ({ request, params }) => dispatch(request, params),
        POST: async ({ request, params }) => dispatch(request, params),
        PUT: async ({ request, params }) => dispatch(request, params),
        DELETE: async ({ request, params }) => dispatch(request, params),
        PATCH: async ({ request, params }) => dispatch(request, params),
        OPTIONS: async ({ request, params }) => dispatch(request, params),
      });
    },
  },
});
