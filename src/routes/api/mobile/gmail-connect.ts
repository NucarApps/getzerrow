// Mobile API — connect a Gmail account and fetch categorization rules.
//
// GET  /api/mobile/gmail-connect
//   -> { rules }  (the user's folders + deterministic filters)
//
// POST /api/mobile/gmail-connect
//   { email_address?, access_token?, refresh_token?, expires_in?, server_auth_code? }
//   -> { ok, account_id, email_address, rules }
//
// The Swift app obtains Google OAuth tokens on-device (GoogleSignIn with Gmail
// scopes + offline access) and hands them off here. The backend stores them
// encrypted, starts the Gmail push watch, kicks off backfill/sync, and returns
// how the user's mail is categorized.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { authenticateRequest } from "@/lib/mobile-auth.server";

const connectSchema = z
  .object({
    email_address: z.string().email().optional(),
    access_token: z.string().min(1).optional(),
    refresh_token: z.string().min(1).optional(),
    expires_in: z
      .number()
      .int()
      .positive()
      .max(60 * 60 * 24)
      .optional(),
    server_auth_code: z.string().min(1).optional(),
  })
  .refine((d) => !!d.server_auth_code || (!!d.access_token && !!d.refresh_token), {
    message: "Provide server_auth_code, or both access_token and refresh_token",
  });

export const Route = createFileRoute("/api/mobile/gmail-connect")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let userId: string;
        try {
          ({ userId } = await authenticateRequest(request));
        } catch (r) {
          if (r instanceof Response) return r;
          return new Response("Unauthorized", { status: 401 });
        }
        try {
          const { getCategorizationRules } = await import("@/lib/mobile-gmail.server");
          const rules = await getCategorizationRules(userId);
          return Response.json({ rules });
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : "Failed to load rules" },
            { status: 500 },
          );
        }
      },
      POST: async ({ request }) => {
        let userId: string;
        try {
          ({ userId } = await authenticateRequest(request));
        } catch (r) {
          if (r instanceof Response) return r;
          return new Response("Unauthorized", { status: 401 });
        }

        let body: z.infer<typeof connectSchema>;
        try {
          body = connectSchema.parse(await request.json());
        } catch {
          return new Response("Invalid connect payload", { status: 400 });
        }

        try {
          const { connectGmailCore, getCategorizationRules } =
            await import("@/lib/mobile-gmail.server");
          const { account_id, email_address } = await connectGmailCore(userId, body);
          const rules = await getCategorizationRules(userId);
          return Response.json({ ok: true, account_id, email_address, rules });
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : "Failed to connect Gmail" },
            { status: 400 },
          );
        }
      },
    },
  },
});
