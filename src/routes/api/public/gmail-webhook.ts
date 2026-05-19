// Gmail Pub/Sub push webhook. Public route — Gmail can't sign with our secret,
// so we verify it's a valid Pub/Sub payload and pull state from our DB.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncSinceHistory } from "@/lib/sync.server";

export const Route = createFileRoute("/api/public/gmail-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();
          // Pub/Sub envelope: { message: { data: base64(JSON {emailAddress, historyId}) } }
          const dataB64 = body?.message?.data;
          if (!dataB64) return new Response("ok", { status: 200 });
          const decoded = JSON.parse(Buffer.from(dataB64, "base64").toString("utf-8"));
          // Find which user this is for — single-tenant; use first user.
          const { data: users } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 });
          const userId = users?.users?.[0]?.id;
          if (!userId) return new Response("no user", { status: 200 });
          await syncSinceHistory(userId);
          return new Response("ok", { status: 200 });
        } catch (e: any) {
          console.error("webhook error", e);
          return new Response("ok", { status: 200 }); // ack to avoid Pub/Sub retries storm
        }
      },
    },
  },
});
