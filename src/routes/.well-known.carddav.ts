// iOS Contacts and macOS calendar/contact clients probe /.well-known/carddav
// before the user's URL to discover the principal. Redirect them to the
// principal-discovery entry. We can't know the user email here; iOS follows
// the 301 and then does PROPFIND with Basic auth, which reveals the email.

import { createFileRoute } from "@tanstack/react-router";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = async (_ctx: any) =>
  new Response(null, {
    status: 301,
    headers: { Location: "/api/public/carddav/" },
  });

export const Route = createFileRoute("/.well-known/carddav")({
  server: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlers: { GET: handler, ANY: handler } as any,
  },
});
