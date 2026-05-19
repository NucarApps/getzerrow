// Polling fallback — call from cron every 1-5 min.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncSinceHistory } from "@/lib/sync.server";

export const Route = createFileRoute("/api/public/gmail-poll")({
  server: {
    handlers: {
      POST: async () => {
        const { data: users } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 });
        const userId = users?.users?.[0]?.id;
        if (!userId) return Response.json({ ok: false, reason: "no user" });
        const r = await syncSinceHistory(userId);
        return Response.json({ ok: true, ...r });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
