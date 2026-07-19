// Mobile API — mail actions for the Rork/Expo companion app.
// POST /api/mobile/emails/action  { action, email_id, to_folder_id? }
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { authenticateRequest } from "@/lib/mobile-auth.server";
import { archiveEmailCore, markEmailReadCore, moveEmailCore } from "@/lib/mobile-actions.server";

const bodySchema = z.object({
  action: z.enum(["archive", "mark_read", "mark_unread", "move"]),
  email_id: z.string().uuid(),
  to_folder_id: z.string().uuid().optional(),
});

export const Route = createFileRoute("/api/mobile/emails/action")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let userId: string;
        try {
          ({ userId } = await authenticateRequest(request));
        } catch (r) {
          if (r instanceof Response) return r;
          return new Response("Unauthorized", { status: 401 });
        }

        let body: z.infer<typeof bodySchema>;
        try {
          body = bodySchema.parse(await request.json());
        } catch {
          return new Response("Invalid request body", { status: 400 });
        }

        try {
          switch (body.action) {
            case "archive":
              await archiveEmailCore(userId, body.email_id);
              break;
            case "mark_read":
              await markEmailReadCore(userId, body.email_id, true);
              break;
            case "mark_unread":
              await markEmailReadCore(userId, body.email_id, false);
              break;
            case "move":
              if (!body.to_folder_id) {
                return new Response("to_folder_id is required for move", { status: 400 });
              }
              await moveEmailCore(userId, body.email_id, body.to_folder_id);
              break;
          }
        } catch (e) {
          return Response.json(
            { ok: false, error: (e as Error)?.message ?? "Action failed" },
            { status: 400 },
          );
        }

        return Response.json({ ok: true });
      },
    },
  },
});
