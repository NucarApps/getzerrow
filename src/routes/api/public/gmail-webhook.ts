// Gmail Pub/Sub push webhook. Looks up the right gmail_account by emailAddress.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncSinceHistory } from "@/lib/sync.server";

export const Route = createFileRoute("/api/public/gmail-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();
          const dataB64 = body?.message?.data;
          if (!dataB64) return new Response("ok", { status: 200 });
          const decoded = JSON.parse(Buffer.from(dataB64, "base64").toString("utf-8")) as {
            emailAddress: string;
            historyId: number | string;
          };
          const { data: accounts } = await supabaseAdmin
            .from("gmail_accounts")
            .select("id")
            .eq("email_address", decoded.emailAddress);
          for (const acc of accounts ?? []) {
            try { await syncSinceHistory(acc.id); } catch (e) { console.error("sync failed for", acc.id, e); }
          }
          return new Response("ok", { status: 200 });
        } catch (e: any) {
          console.error("webhook error", e);
          return new Response("ok", { status: 200 });
        }
      },
    },
  },
});
