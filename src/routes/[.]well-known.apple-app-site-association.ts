import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

// Apple App Site Association (AASA) — served at
// /.well-known/apple-app-site-association with a 200 and Content-Type
// application/json so the iOS app can verify domain ownership (Associated
// Domains: webcredentials + applinks). Served via a server route rather than a
// static public/ file because extensionless static assets are not reliably
// served with application/json on the Cloudflare Workers deployment.
const AASA = {
  webcredentials: {
    apps: ["78TF75BED3.app.rork.vgbwcg1s46vqobhajrjd5"],
  },
  applinks: {
    apps: [],
    details: [
      {
        appIDs: ["78TF75BED3.app.rork.vgbwcg1s46vqobhajrjd5"],
        components: [],
      },
    ],
  },
} as const;

export const Route = createFileRoute("/.well-known/apple-app-site-association")({
  server: {
    handlers: {
      GET: async () => {
        return new Response(JSON.stringify(AASA), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
