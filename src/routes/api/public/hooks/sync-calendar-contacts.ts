// Daily cron tick: refresh calendar attendees for every account that has the
// cold-email guard enabled and has granted calendar access. Authenticated via
// CRON_SECRET (cron-auth) — never the publishable key.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncCalendarContacts } from "@/lib/calendar.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";

export const Route = createFileRoute("/api/public/hooks/sync-calendar-contacts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("sync-calendar-contacts", async ({ runId }) => {
          const { data: accounts, error } = await supabaseAdmin
            .from("gmail_accounts")
            .select("id, user_id")
            .eq("calendar_guard_enabled", true)
            .eq("calendar_access", true)
            .order("calendar_synced_at", { ascending: true, nullsFirst: true })
            .limit(25);
          if (error) {
            logError("calendar_sync.query_failed", { run_id: runId }, error);
            return new Response(JSON.stringify({ error: error.message }), {
              status: 500, headers: { "Content-Type": "application/json" },
            });
          }

          let succeeded = 0;
          let failed = 0;
          for (const acc of accounts ?? []) {
            try {
              await syncCalendarContacts(acc.id, acc.user_id);
              succeeded++;
            } catch (e) {
              logError("calendar_sync.iter_failed", { run_id: runId, account_id: acc.id, user_id: acc.user_id }, e);
              failed++;
            }
          }
          return new Response(
            JSON.stringify({ checked: accounts?.length ?? 0, succeeded, failed, run_id: runId }),
            { headers: { "Content-Type": "application/json" } },
          );
        });
      },
    },
  },
});
