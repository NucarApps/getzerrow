// Mobile API — send a test push to the signed-in user's registered devices.
// Lets the Rork/Expo app confirm push wiring end to end.
// POST /api/mobile/push-test  -> { ok }
import { createFileRoute } from "@tanstack/react-router";
import { authenticateRequest } from "@/lib/mobile-auth.server";

export const Route = createFileRoute("/api/mobile/push-test")({
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

        const { sendPushToUser } = await import("@/lib/push.server");
        await sendPushToUser(userId, {
          title: "Zerrow",
          body: "Push notifications are working.",
          data: { type: "test" },
        });
        return Response.json({ ok: true });
      },
    },
  },
});
